import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Wallet, RefreshCw, Search, FileJson, Copy } from 'lucide-react';
import {
  api,
  opencodeApi,
  type QuotaOverview,
  type QuotaPairRow,
  type CredentialQuotaView,
  type QuotaWindow,
  type LastProbeCapture,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { fmtDur } from '../lib/format';
import { ProviderLogo } from '../components/ProviderLogo';
import { Dialog } from '../components/Dialog';
import { useToast } from '../components/ToastProvider';
import { byQuotaUrgency } from '../lib/quotaRank';

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
 * tick), a compact summary strip of aggregate scan-aid chips (covered pairs /
 * low-quota windows / sync failures / earliest reset), then a responsive card
 * grid — one usage-meter card per covered pair, the standard quota-widget
 * pattern: identity + provenance badge in the header, one full-width burn bar
 * per window (caption line above the bar: window label + reset countdown on
 * the left, the value on the right), plan/entry and the last-probe raw-body
 * button in the footer. Full-width bars keep every meter on the same track no
 * matter how long the labels are — the old table squeezed bars into a column
 * beside variable-width text. Uncovered pairs are never rendered (no coverage
 * ⇒ no quota to show). Synced rows lead, unread ones sink. The release
 * coverage plan, the rejected quotaProbes entries and the burn-event ledger
 * stay on the `GET /api/admin/quota` diagnostics contract — they are not
 * rendered here.
 */

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: '11.5px' };

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

const pctColor = (p: number): string =>
  p < 10 ? 'var(--accent-rose)' : p < 25 ? 'var(--accent-amber)' : 'var(--accent)';

/** One summary-strip chip: a pill carrying a single aggregate signal. */
const StatChip: React.FC<{ text: string; tone?: 'warn' | 'info' }> = ({ text, tone }) => {
  const color = tone === 'warn' ? 'var(--accent-rose)' : tone === 'info' ? 'var(--accent)' : 'var(--text-dim)';
  return (
    <span
      style={{
        ...MONO,
        padding: '3px 10px',
        borderRadius: '999px',
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
};

const BadgePill: React.FC<{ quota: CredentialQuotaView; stateWord: (k: string) => string }> = ({ quota, stateWord }) => {
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

/**
 * One quota window as a usage meter: a caption line (window label + reset
 * countdown left, value right) over a burn bar spanning the full card width.
 * The bar only appears when there is a percentage to burn against.
 */
const WindowMeter: React.FC<{ w: QuotaWindow; t: (k: string, p?: Record<string, string | number>) => string }> = ({ w, t }) => {
  const pct = w.remainingPct;
  // A cash-balance pool has no cap to burn against — the snapshot flattens it
  // to used=0 / total=balance, so its percent is always 100 and a bar would be
  // meaningless. Show the absolute amount instead.
  const isBalance = w.nameCode === 'balance' && w.total !== null;
  const amount = Math.max(0, (w.total ?? 0) - (w.used ?? 0));
  const noCap = !isBalance && (w.unlimited || (w.total === null && pct === null));
  // i18n: a machine-readable nameCode maps to a translated label (the repo's
  // noteCode pattern); unknown codes and legacy snapshots show the raw name.
  let label = w.name;
  if (w.nameCode) {
    const key = `quotaPage.wn.${w.nameCode}`;
    const translated = t(key, w.nameArg !== undefined ? { n: w.nameArg } : undefined);
    if (translated !== key) label = translated;
  }
  let value: string;
  let valueColor: string;
  if (isBalance) {
    value = `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}${w.nameArg ? ` ${w.nameArg}` : ''}`;
    valueColor = amount <= 0 ? 'var(--accent-rose)' : 'var(--text-main)';
  } else if (noCap) {
    value = t('quotaPage.windowNoCap');
    valueColor = 'var(--text-dim)';
  } else if (pct !== null) {
    value = `${Math.round(pct)}%`;
    valueColor = pctColor(pct);
  } else {
    value = `${amount.toLocaleString()} / ${(w.total ?? 0).toLocaleString()}`;
    valueColor = 'var(--text-main)';
  }
  let caption = label;
  if (w.resetAt !== null) {
    caption +=
      w.resetAt > Date.now()
        ? t('quotaPage.windowResets', { when: fmtDur(w.resetAt - Date.now()) })
        : t('quotaPage.windowExpired');
  }
  return (
    <div style={{ marginTop: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
        <span style={{ fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={caption}>
          {caption}
        </span>
        <span style={{ ...MONO, fontWeight: 700, color: valueColor, flexShrink: 0 }}>{value}</span>
      </div>
      {pct !== null && !isBalance && !noCap && (
        <div style={{ marginTop: '5px', height: '6px', borderRadius: '3px', background: 'var(--chip-bg)', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${Math.max(2, Math.min(100, pct))}%`,
              borderRadius: '3px',
              background: pctColor(pct),
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      )}
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
      // Row identity only: provider + credential (label or key-hash). Plan/entry
      // metadata is deliberately not searchable.
      rows = rows.filter((r) =>
        `${r.providerId} ${r.keyHashPrefix} ${r.label ?? ''}`.toLowerCase().includes(needle)
      );
    }
    // Urgency-first ordering (shared with the sidebar peek): the scarcest
    // window leads, drained balances next, sync failures and never-read
    // pairs sink to the bottom. See lib/quotaRank.ts.
    rows = [...rows].sort(byQuotaUrgency);
    return rows;
  }, [data, q]);

  // Compact summary strip — aggregate signals derived from the same covered
  // pairs the grid renders (the search box does not affect it): how many
  // windows are nearly drained, how many pairs failed to sync, and when the
  // earliest live window resets. Display-only, like everything on this page.
  const summary = useMemo(() => {
    const rows = (data?.pairs ?? []).filter((r) => r.covered);
    if (rows.length === 0) return null;
    const now = Date.now();
    let lowWindows = 0;
    let stalePairs = 0;
    let nextReset: number | null = null;
    for (const r of rows) {
      if (r.quota?.badge === 'stale') stalePairs += 1;
      for (const w of r.quota?.windows ?? []) {
        if (!w.unlimited && w.remainingPct !== null && w.remainingPct < 10) lowWindows += 1;
        if (w.resetAt !== null && w.resetAt > now && (nextReset === null || w.resetAt < nextReset)) nextReset = w.resetAt;
      }
    }
    return { pairs: rows.length, lowWindows, stalePairs, nextReset };
  }, [data]);

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

      {/* ── Summary strip: scan-aid chips over the directory ──────────────── */}
      {summary && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <StatChip text={t('quotaPage.sumPairs', { n: summary.pairs })} />
          <StatChip text={t('quotaPage.sumLow', { n: summary.lowWindows })} tone={summary.lowWindows > 0 ? 'warn' : undefined} />
          <StatChip text={t('quotaPage.sumStale', { n: summary.stalePairs })} tone={summary.stalePairs > 0 ? 'warn' : undefined} />
          {summary.nextReset !== null && (
            <StatChip text={t('quotaPage.sumNextReset', { when: fmtDur(summary.nextReset - Date.now()) })} tone="info" />
          )}
        </div>
      )}

      {/* ── Filter toolbar: free-text search only — provider / credential (label
          or key-hash) match through the search, plan/entry do not. Cards are
          pre-filtered to covered pairs, so there is no view segment. ──────── */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <div style={{ position: 'relative', width: '300px', maxWidth: '100%' }}>
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

      {/* ── Connected pairs directory — the single surface ────────────────── */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {error && (
          <div style={{ padding: '10px 14px', fontSize: '12px', color: 'var(--accent-rose)' }}>{error}</div>
        )}
        {filteredPairs.length === 0 ? (
          <div style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '12.5px' }}>
            {t('quotaPage.pairsEmpty')}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: '12px', alignContent: 'start', paddingRight: '2px' }}>
            {filteredPairs.map((row: QuotaPairRow) => {
              const meta = [row.quota?.plan, row.quota?.entryId].filter(Boolean).join(' · ');
              return (
                <div key={`${row.providerId}#${row.keyHashPrefix}`} className="card" style={{ padding: '14px 16px', minWidth: 0 }}>
                  {/* Header: identity + provenance badge + read freshness */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
                    <ProviderLogo providerId={row.providerId} logoMap={logoMap} size={30} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.providerId}>
                        {row.providerId}
                      </div>
                      <div style={{ ...MONO, fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.label || row.keyHashPrefix}>
                        {row.label || row.keyHashPrefix}
                      </div>
                    </div>
                    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: 0 }}>
                      {!row.quota ? (
                        <span style={{ color: 'var(--text-dim)', fontSize: '11.5px' }}>—</span>
                      ) : (
                        <BadgePill quota={row.quota} stateWord={stateWord} />
                      )}
                      {row.quota?.verifiedAt && (
                        <span style={{ ...MONO, fontSize: '10.5px', color: 'var(--text-dim)' }}>
                          {t('quotaPage.agoLine', { when: fmtDur(Date.now() - row.quota.verifiedAt) })}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* One usage meter per tracked window */}
                  {row.quota && row.quota.windows.length > 0 ? (
                    row.quota.windows.map((w) => <WindowMeter key={w.name} w={w} t={t} />)
                  ) : (
                    <div style={{ marginTop: '10px', fontSize: '11.5px', color: 'var(--text-dim)' }}>—</div>
                  )}
                  {/* Footer: plan/entry provenance + raw last-probe body */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                      marginTop: '12px',
                      paddingTop: '8px',
                      borderTop: '1px solid var(--divider)',
                      minWidth: 0,
                    }}
                  >
                    <span style={{ ...MONO, fontSize: '10.5px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={meta || undefined}>
                      {meta}
                    </span>
                    <button
                      className="btn btn-sm"
                      style={{ padding: '3px 6px', flexShrink: 0 }}
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
