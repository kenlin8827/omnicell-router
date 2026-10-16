import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Wallet, RefreshCw, Search, FileJson, Copy } from 'lucide-react';
import {
  api,
  opencodeApi,
  type QuotaOverview,
  type QuotaPairRow,
  type AccountQuotaView,
  type QuotaWindow,
  type LastProbeCapture,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { ProviderLogo } from '../components/ProviderLogo';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';

/**
 * Quota tracking overview — every CONNECTED (provider × credential) pair of a
 * covered provider with its tracked allowance. Coverage ships with the release,
 * activation follows credentials: a pair row appears the moment its provider is
 * covered and its credential exists; the badge starts `unverified` and lands on
 * real numbers after the first probe. This page is display-only by contract —
 * nothing here gates routing.
 *
 * Layout: a page header with a manual refresh button (re-arms the probe
 * schedule — invalidation only, fresh numbers land on the next scheduler
 * tick) above the pair directory (badge + provenance + window bars +
 * served-usage join, all carried inside the cells they annotate); uncovered
 * pairs are never rendered (no coverage ⇒ no quota to show). Synced rows lead,
 * unread ones sink. The release
 * coverage plan, the rejected quotaProbes entries and the burn-event ledger
 * stay on the `GET /api/admin/quota` diagnostics contract — they are not
 * rendered here.
 */

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: '11.5px' };

const TH: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '11px',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
  borderBottom: '1px solid var(--divider)',
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  padding: '14px 12px',
  lineHeight: 1.55,
  borderBottom: '1px solid var(--divider)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};

/** Compact duration ("45s" / "3m" / "2h" / "5d"). */
function fmtDur(ms: number): string {
  if (ms <= 0) return '0s';
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Pretty-print a captured probe body: parsed JSON → indented, text → verbatim. */
function prettyBody(b: unknown): string {
  if (b === undefined || b === null) return '—';
  if (typeof b === 'string') return b;
  try {
    return JSON.stringify(b, null, 2);
  } catch {
    return String(b);
  }
}

const STATE_COLORS: Record<string, string> = {
  probed: 'var(--accent)',
  declared: 'var(--text-dim)',
  unverified: 'var(--accent-amber)',
  stale: 'var(--accent-rose)',
};

const BadgePill: React.FC<{ quota: AccountQuotaView; stateWord: (k: string) => string }> = ({ quota, stateWord }) => {
  const color = STATE_COLORS[quota.badge] ?? 'var(--text-dim)';
  return (
    <span
      style={{
        fontSize: '10.5px',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: '99px',
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        color,
        background: 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {stateWord(quota.badge)}
    </span>
  );
};

/** One quota window: label + percent bar (or absolute line) + reset countdown. */
const WindowLine: React.FC<{ w: QuotaWindow; t: (k: string, p?: Record<string, string | number>) => string }> = ({ w, t }) => {
  const pct = w.remainingPct;
  const barColor = pct === null ? 'var(--text-dim)' : pct < 10 ? 'var(--accent-rose)' : pct < 25 ? 'var(--accent-amber)' : 'var(--accent)';
  // A cash-balance pool has no cap to burn against — the snapshot flattens it
  // to used=0 / total=balance, so its percent is always 100 and a bar would
  // be meaningless. Show the absolute amount instead.
  const isBalance = w.nameCode === 'balance' && w.total !== null;
  const amount = Math.max(0, (w.total ?? 0) - (w.used ?? 0));
  // i18n: a machine-readable nameCode maps to a translated label (the repo's
  // noteCode pattern); unknown codes and legacy snapshots show the raw name.
  let label = w.name;
  if (w.nameCode) {
    const key = `quotaPage.wn.${w.nameCode}`;
    const translated = t(key, w.nameArg !== undefined ? { n: w.nameArg } : undefined);
    if (translated !== key) label = translated;
  }
  let text: string;
  if (isBalance)
    text = t('quotaPage.windowBalance', {
      amount: amount.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      currency: w.nameArg ? ` ${w.nameArg}` : '',
    });
  else if (w.unlimited || (w.total === null && pct === null)) text = t('quotaPage.windowNoCap');
  else if (pct !== null) text = t('quotaPage.windowLeft', { pct: Math.round(pct) });
  else text = `${Math.max(0, (w.total ?? 0) - (w.used ?? 0)).toLocaleString()} / ${(w.total ?? 0).toLocaleString()}`;
  if (w.resetAt !== null) {
    text += w.resetAt > Date.now()
      ? t('quotaPage.windowResets', { when: fmtDur(w.resetAt - Date.now()) })
      : t('quotaPage.windowExpired');
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
      <span style={{ ...MONO, width: '120px', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-main)' }} title={label}>
        {label}
      </span>
      <span style={{ width: '96px', flexShrink: 0 }}>
        {!isBalance &&
          pct !== null && (
            <span style={{ display: 'block', height: '4px', borderRadius: '2px', background: 'var(--chip-bg)', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${Math.max(2, Math.min(100, pct))}%`, background: barColor }} />
            </span>
          )}
      </span>
      <span style={{ fontSize: '11px', color: isBalance ? (amount <= 0 ? 'var(--accent-rose)' : 'var(--text-main)') : barColor, whiteSpace: 'nowrap' }}>{text}</span>
    </div>
  );
};

export const QuotaPage: React.FC = () => {
  const { t } = useI18n();
  const [data, setData] = useState<QuotaOverview | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoMap, setLogoMap] = useState<Record<string, string>>({});
  const [lastProbe, setLastProbe] = useState<{ title: string; http: LastProbeCapture | null } | null>(null);
  const toast = useToast();

  // provider id → logo URL (OCR catalog view); logos are decorative, failures ignored
  useEffect(() => {
    (async () => {
      try {
        const res = await opencodeApi.listProviders();
        const map: Record<string, string> = {};
        for (const p of res?.providers || []) if (p.id && p.logo) map[p.id] = p.logo as string;
        setLogoMap(map);
      } catch {
        // decorative only
      }
    })();
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getQuotaOverview();
      setData(res);
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

  // Manual refresh: re-arm the whole probe schedule (POST is invalidation
  // only — never synchronous), then re-read the snapshot. Fresh numbers
  // land when the scheduler fires its next tick.
  const onRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const armed = await api.refreshQuota().catch(() => ({ status: 'ok', success: false }));
      await loadData();
      if (armed.success) toast.info(t('quotaPage.refreshQueued'));
      else toast.error(t('quotaPage.refreshUnavailable'));
    } finally {
      setLoading(false);
    }
  }, [loadData, t, toast]);

  const stateWord = useCallback(
    (badge: string): string =>
      badge === 'probed'
        ? t('quotaPage.stateProbed')
        : badge === 'declared'
          ? t('quotaPage.stateDeclared')
          : badge === 'stale'
            ? t('quotaPage.stateStale')
            : t('quotaPage.stateUnverified'),
    [t]
  );

  const filteredPairs = useMemo(() => {
    // Covered pairs only — an uncovered (provider × credential) row carries no
    // probeable quota, so rendering it is noise; no view filter is offered.
    let rows = (data?.pairs ?? []).filter((r) => r.covered);
    if (q) {
      const needle = q.toLowerCase();
      // Row identity only: provider + account (label or key-hash). Plan/entry
      // metadata is deliberately not searchable.
      rows = rows.filter((r) =>
        `${r.providerId} ${r.keyHashPrefix} ${r.label ?? ''}`.toLowerCase().includes(needle)
      );
    }
    // Synced-first ordering: rows carrying a real read (verifiedAt) lead,
    // newest on top; the unread tail sinks, by provider identity so the row
    // order stays deterministic across reloads.
    rows = [...rows].sort((a, b) => {
      const av = a.quota?.verifiedAt;
      const bv = b.quota?.verifiedAt;
      if (av === undefined && bv !== undefined) return 1;
      if (av !== undefined && bv === undefined) return -1;
      if (av !== undefined && bv !== undefined && av !== bv) return bv - av;
      const an = `${a.providerId}#${a.keyHashPrefix}`;
      const bn = `${b.providerId}#${b.keyHashPrefix}`;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return rows;
  }, [data, q]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0 }}>
      {/* ── Page header: identity + refresh ───────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        <Wallet size={20} color="var(--accent)" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: '16px', fontWeight: 700, whiteSpace: 'nowrap' }}>{t('quotaPage.pageTitle')}</span>
        <span style={{ fontSize: '11.5px', color: 'var(--text-dim)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('quotaPage.pageSubtitle')}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
          <button className="btn btn-sm" onClick={onRefresh} disabled={loading} title={t('quotaPage.refreshNow')}>
            <RefreshCw size={12} style={loading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
      </div>

      {data && !data.enabled && (
        <div style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-amber) 10%, transparent)', color: 'var(--accent-amber)' }}>
          {t('quotaPage.disabledBanner')}
        </div>
      )}

      {/* ── Connected pairs directory — the single surface ────────────────── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
        {/* Filter toolbar: free-text search only — provider / account (label
            or key-hash) match through the search, plan/entry do not. Rows are
            pre-filtered to covered pairs, so there is no view segment. */}
        <div style={{ display: 'flex', gap: '8px', padding: '10px 14px', flexWrap: 'wrap', alignItems: 'center', borderBottom: '1px solid var(--divider)' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '180px' }}>
            <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              className="input"
              style={{ width: '100%', fontSize: '12px', paddingLeft: '30px' }}
              placeholder={t('quotaPage.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {error && (
            <div style={{ padding: '10px 14px', fontSize: '12px', color: 'var(--accent-rose)' }}>{error}</div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr>
                <th style={TH}>{t('quotaPage.colAccount')}</th>
                <th style={{ ...TH, textAlign: 'center' }}>{t('quotaPage.colState')}</th>
                <th style={TH}>{t('quotaPage.colPlan')}</th>
                <th style={{ ...TH, minWidth: '320px' }}>{t('quotaPage.colQuota')}</th>
                <th style={{ ...TH, textAlign: 'center', width: '56px' }} title={t('quotaPage.lastProbeBtn')}>
                  <FileJson size={13} style={{ verticalAlign: '-2px', color: 'var(--text-dim)' }} aria-hidden />
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredPairs.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12.5px' }}>
                    {t('quotaPage.pairsEmpty')}
                  </td>
                </tr>
              )}
              {filteredPairs.map((row: QuotaPairRow) => (
                <tr key={`${row.providerId}#${row.keyHashPrefix}`}>
                  <td style={TD}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                      {/* Logo vertically centered against the two-line block. */}
                      <ProviderLogo providerId={row.providerId} logoMap={logoMap} size={32} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{row.providerId}</div>
                        <div style={{ ...MONO, color: 'var(--text-dim)' }}>{row.label || row.keyHashPrefix}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ ...TD, textAlign: 'center' }}>
                    {!row.quota ? (
                      <span style={{ color: 'var(--text-dim)', fontSize: '11.5px' }}>—</span>
                    ) : (
                      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                        <BadgePill quota={row.quota} stateWord={stateWord} />
                        {row.quota.verifiedAt && (
                          <span style={{ ...MONO, color: 'var(--text-dim)' }}>
                            {t('quotaPage.agoLine', { when: fmtDur(Date.now() - row.quota.verifiedAt) })}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td style={TD}>
                    {row.quota?.plan && <div style={{ fontSize: '12px' }}>{row.quota.plan}</div>}
                    {row.quota?.entryId && <div style={{ ...MONO, color: 'var(--text-dim)' }}>{row.quota.entryId}</div>}
                  </td>
                  <td style={TD}>
                    {row.quota && row.quota.windows.length > 0 ? (
                      row.quota.windows.map((w) => <WindowLine key={w.name} w={w} t={t} />)
                    ) : (
                      <span style={{ color: 'var(--text-dim)', fontSize: '11.5px' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: 'center' }}>
                    <button
                      className="btn btn-sm"
                      style={{ padding: '3px 6px' }}
                      title={t('quotaPage.lastProbeBtn')}
                      onClick={async () => {
                        const title = `${row.providerId} · ${row.label || row.keyHashPrefix}`;
                        try {
                          const res = await api.getLastProbe(row.providerId, row.keyHashPrefix);
                          setLastProbe({ title, http: res.http });
                        } catch {
                          setLastProbe({ title, http: null });
                        }
                      }}
                    >
                      <FileJson size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Last-probe dialog: the raw quota-endpoint response, pretty-printed ─ */}
      {lastProbe && (
        <Dialog
          title={t('quotaPage.lastProbeTitle')}
          subtitle={lastProbe.title}
          width={720}
          onClose={() => setLastProbe(null)}
          closeLabel={t('common.close')}
          headerActions={
            lastProbe.http ? (
              <button
                className="btn btn-sm"
                style={{ display: 'flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px' }}
                title={t('quotaPage.lastProbeCopy')}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(prettyBody(lastProbe.http!.body));
                    toast.success(t('quotaPage.lastProbeCopied'));
                  } catch {
                    toast.error(t('quotaPage.lastProbeCopyFailed'));
                  }
                }}
              >
                <Copy size={11} />
                {t('quotaPage.lastProbeCopy')}
              </button>
            ) : undefined
          }
        >
          {lastProbe.http ? (
            <>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ ...MONO, fontWeight: 700, color: lastProbe.http.ok ? 'var(--accent)' : 'var(--accent-rose)' }}>
                  {lastProbe.http.status != null ? `HTTP ${lastProbe.http.status}` : t('quotaPage.lastProbeNetwork')}
                </span>
                {lastProbe.http.durationMs !== undefined && (
                  <span style={{ ...MONO, color: 'var(--text-dim)' }}>{lastProbe.http.durationMs}ms</span>
                )}
              </div>
              <div style={{ ...MONO, color: 'var(--text-dim)', marginBottom: 8, wordBreak: 'break-all' }}>{lastProbe.http.url}</div>
              <pre
                style={{
                  margin: 0,
                  maxHeight: 420,
                  overflow: 'auto',
                  fontSize: 12,
                  lineHeight: 1.55,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: 'var(--text-main)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: 'var(--card-bg)',
                  border: '1px solid var(--card-border)',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                {prettyBody(lastProbe.http.body)}
              </pre>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', padding: '12px 0' }}>{t('quotaPage.lastProbeEmpty')}</div>
          )}
        </Dialog>
      )}
    </div>
  );
};
