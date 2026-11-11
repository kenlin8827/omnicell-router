import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Wallet, RefreshCw } from 'lucide-react';
import { api, type QuotaOverview, type QuotaWindow, type CredentialQuotaView } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { fmtDur } from '../lib/format';
import { byQuotaUrgency, headlineWindow } from '../lib/quotaRank';
import { failureCaption, quotaStateWord, quotaSyncFailed } from '../lib/quotaFailure';
import { useQuotaRefresh } from '../lib/useQuotaRefresh';

import { FONT_MONO } from '../lib/fonts';
/**
 * Sidebar-resident quota peek — the wallet chip in the footer's right slot.
 * Hover opens a compact glass panel to the RIGHT of the chip (portal-mounted
 * on document.body: the sidebar's backdrop-filter traps fixed positioning
 * and its overflow would clip an in-column panel); click navigates to the
 * full quota directory. Display-only, like the quota page itself: nothing
 * here gates routing.
 *
 * Row anatomy (a compact usage-meter card per covered pair — the standard
 * quota-widget pattern where the burn bar spans the full row width, so every
 * meter shares the exact same track): line 1 = provider + the headline
 * window's percentage (or the cash balance); line 2 = the bar; line 3 = a
 * quiet caption under the bar (window label left, reset countdown right).
 * Rows are hover tiles (.quota-peek-row in index.css), not table lines.
 *
 * Hover continuity across the chip→panel gap is kept by a 250ms close delay
 * shared between the chip wrapper and the panel.
 *
 * Data: polls GET /api/admin/quota every 60s (the snapshot is written by the
 * probe scheduler, so a minute-granularity lamp is the freshest honest view)
 * and re-fetches whenever the panel opens; the header's refresh button runs
 * the same synchronous manual refresh as the quota page (shared
 * lib/useQuotaRefresh), so a stale number never forces a navigation. The chip
 * lamp mirrors the scarcest headline window across all pairs (rose <10%,
 * amber <25%).
 */

const MONO: React.CSSProperties = { fontFamily: FONT_MONO };

const pctColor = (p: number): string =>
  p < 10 ? 'var(--accent-rose)' : p < 25 ? 'var(--accent-amber)' : 'var(--accent)';

export const QuotaPeek: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [data, setData] = useState<QuotaOverview | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Same status segments as the quota page, same default: sync-failed pairs
  // stay out of the healthy view so the at-a-glance panel lists only pairs
  // whose numbers are trustworthy.
  const [peekFilter, setPeekFilter] = useState<'ok' | 'failed' | 'all'>('ok');

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  // Close model follows Radix HoverCard's safe-polygon pattern: while the
  // panel is open, document-level pointermove is the ONLY close trigger.
  // A pointer that moves OUTSIDE both the chip and the panel (each rect
  // padded, so the chip→panel gap stays traversable) arms a short close
  // timer; any move back inside disarms it. Nothing else closes the panel:
  // a stationary cursor never fires pointermove, so layout shifts (the
  // status-segment swap shrinking this bottom-anchored panel out from under
  // the cursor, re-renders, jitter) can no longer synthesize a mouseleave
  // and hide it mid-use; fast diagonal sweeps that clip a panel edge for a
  // frame re-enter before the timer fires.
  useEffect(() => {
    if (!open) return;
    const contains = (r: DOMRect | undefined, x: number, y: number, pad: number) =>
      !!r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    const onMove = (e: MouseEvent) => {
      const inside =
        contains(btnRef.current?.getBoundingClientRect(), e.clientX, e.clientY, 12) ||
        contains(panelRef.current?.getBoundingClientRect(), e.clientX, e.clientY, 6);
      if (inside) cancelClose();
      else if (!closeTimer.current) closeTimer.current = setTimeout(() => setOpen(false), 200);
    };
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('mousemove', onMove);
      cancelClose();
    };
  }, [open, cancelClose]);

  const openPanel = useCallback(() => {
    cancelClose();
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: r.right + 10, bottom: window.innerHeight - r.bottom });
    }
    setOpen(true);
  }, [cancelClose]);

  const load = useCallback(() => {
    api.getQuotaOverview().then(setData).catch(() => {
      // Gateway unreachable or quota route missing — the lamp stays dim.
    });
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Same manual refresh as the quota page header (one shared hook): the POST
  // invalidates + probes inside the request, then `load` re-reads the fresh
  // snapshot — the peek never needs to wait for its own 60 s poll.
  const { refresh, isRefreshing } = useQuotaRefresh(load);

  // Same urgency-first order as the quota page, narrowed by the status
  // segment (the healthy default hides sync-failed pairs).
  const rows = useMemo(
    () =>
      (data?.pairs ?? [])
        .filter((r) => r.covered)
        .filter((r) => peekFilter === 'all' || (peekFilter === 'failed') === quotaSyncFailed(r.quota))
        .sort(byQuotaUrgency),
    [data, peekFilter]
  );

  const globalWorst = useMemo(() => {
    let m: number | null = null;
    for (const r of rows) {
      const w = headlineWindow(r.quota?.windows ?? []);
      if (w && w.remainingPct !== null && (m === null || w.remainingPct < m)) m = w.remainingPct;
    }
    return m;
  }, [rows]);

  const lamp = globalWorst === null ? 'var(--text-dim)' : pctColor(globalWorst);

  const winLabel = (w: QuotaWindow): string => {
    if (w.nameCode) {
      const key = `quotaPage.wn.${w.nameCode}`;
      const v = t(key, w.nameArg !== undefined ? { n: w.nameArg } : undefined);
      if (v !== key) return v;
    }
    return w.name;
  };

  const badgeWord = (quota: CredentialQuotaView): string => quotaStateWord(quota, t);

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
      onMouseEnter={openPanel}
    >
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          setOpen(false);
          navigate('/quota');
        }}
        aria-label={t('nav.quotaPeekTitle')}
        style={{
          background: 'none',
          border: 'none',
          padding: '2px 4px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          cursor: 'pointer',
        }}
      >
        <Wallet size={13} color={lamp} style={{ flexShrink: 0 }} />
        {/* Text readout: the scarcest headline percentage across all pairs
            (the chip itself is the at-a-glance alarm); falls back to the
            panel name while data is absent (loading, gateway down, or no
            pairs). */}
        <span style={{ ...MONO, fontSize: 'var(--text-xs)', fontWeight: 'var(--font-bold)', color: lamp, whiteSpace: 'nowrap' }}>
          {globalWorst === null ? t('nav.quotaPeekTitle') : `${Math.round(globalWorst)}%`}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, width: '340px', zIndex: 100 }}
          >
            <div
              style={{
                background: 'color-mix(in srgb, var(--card-bg) 92%, transparent)',
                backdropFilter: 'blur(18px) saturate(1.3)',
                border: '1px solid color-mix(in srgb, var(--accent) 16%, var(--card-border))',
                borderRadius: '12px',
                boxShadow: '0 18px 50px rgba(0, 0, 0, 0.45)',
                padding: '12px 12px 10px',
              }}
            >
              {/* Header: identity + covered-pair count pill */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '0 2px 10px',
                  borderBottom: '1px solid var(--divider)',
                  marginBottom: '6px',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                  <Wallet size={13} color="var(--accent)" />
                  <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-bold)', letterSpacing: 'var(--tracking-wide)', color: 'var(--text-main)' }}>
                    {t('nav.quotaPeekTitle')}
                  </span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  {/* Manual refresh lives here too: the peek is the at-a-glance
                      surface, so a stale number must be re-fetchable in place
                      instead of forcing a trip to /admin/quota. */}
                  <button
                    className="btn btn-sm"
                    style={{ padding: '2px 5px', height: 20 }}
                    disabled={isRefreshing()}
                    title={t('quotaPage.refreshNow')}
                    aria-label={t('quotaPage.refreshNow')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void refresh();
                    }}
                  >
                    <RefreshCw size={11} style={isRefreshing() ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
                  </button>
                  <span
                    style={{
                      ...MONO,
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-dim)',
                      border: '1px solid var(--card-border)',
                      borderRadius: '999px',
                      padding: '2px 8px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('quotaPage.sumPairs', { n: rows.length })}
                  </span>
                </span>
              </div>
              {data && !data.enabled && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)', padding: '2px 2px 6px' }}>{t('nav.quotaPeekOff')}</div>
              )}
              {/* Status segments — same words and default as the page, sized
                  down for the 340px panel. The count pill above reflects the
                  active segment. */}
              <div style={{ display: 'flex', gap: '4px', padding: '0 2px 8px' }}>
                {(['ok', 'failed', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    style={{
                      padding: '2px 9px',
                      fontSize: 'var(--text-xs)',
                      border: '1px solid var(--card-border)',
                      borderRadius: '999px',
                      cursor: 'pointer',
                      background: peekFilter === f ? 'var(--accent)' : 'transparent',
                      color: peekFilter === f ? 'var(--bg)' : 'var(--text-dim)',
                      fontWeight: peekFilter === f ? 'var(--font-bold)' : 'var(--font-regular)',
                    }}
                    onClick={() => setPeekFilter(f)}
                  >
                    {f === 'ok' ? t('quotaPage.filterOk') : f === 'failed' ? t('quotaPage.filterFailed') : t('quotaPage.filterAll')}
                  </button>
                ))}
              </div>
              {rows.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', padding: '10px 2px' }}>{t('nav.quotaPeekNoPairs')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: 'min(60vh, 460px)', overflowY: 'auto' }}>
                  {rows.map((r) => {
                    const windows = r.quota?.windows ?? [];
                    const w = headlineWindow(windows);
                    const balance = w ? undefined : windows.find((x) => x.nameCode === 'balance');
                    let headValue: React.ReactNode;
                    let subLabel = '';
                    let pct: number | null = null;
                    let resetText: string | null = null;
                    if (w && w.remainingPct !== null) {
                      pct = w.remainingPct;
                      headValue = (
                        <span style={{ ...MONO, fontSize: 'var(--text-md)', fontWeight: 'var(--font-bold)', color: pctColor(pct), flexShrink: 0 }}>
                          {Math.round(pct)}%
                        </span>
                      );
                      // Absolute usage next to the label (page meters show
                      // "used / total · pct" — the compact row keeps the pct
                      // as the headline and puts the counts in the caption).
                      subLabel =
                        w.used !== null && w.total !== null
                          ? `${winLabel(w)} · ${w.used.toLocaleString()} / ${w.total.toLocaleString()}`
                          : winLabel(w);
                      if (w.resetAt !== null && w.resetAt > Date.now()) {
                        resetText = t('quotaPage.peekResets', { when: fmtDur(w.resetAt - Date.now()) });
                      }
                    } else if (balance) {
                      const amount = Math.max(0, (balance.total ?? 0) - (balance.used ?? 0));
                      headValue = (
                        <span style={{ ...MONO, fontSize: 'var(--text-md)', fontWeight: 'var(--font-bold)', color: amount <= 0 ? 'var(--accent-rose)' : 'var(--text-main)', flexShrink: 0 }}>
                          {amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          {balance.nameArg ? <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-medium)', color: 'var(--text-dim)' }}> {balance.nameArg}</span> : null}
                        </span>
                      );
                      subLabel = winLabel(balance);
                    } else {
                      const quota = r.quota;
                      const failed = failureCaption(quota, t);
                      headValue = (
                        <span
                          style={{
                            fontSize: 'var(--text-xs)',
                            fontWeight: 'var(--font-semibold)',
                            color: quota?.badge === 'stale' || failed ? 'var(--accent-rose)' : 'var(--text-dim)',
                            flexShrink: 0,
                          }}
                        >
                          {quota ? badgeWord(quota) : '—'}
                        </span>
                      );
                      // A recorded verdict explains the empty state — a bare
                      // "unverified" would read as "still waiting for the first sync".
                      if (failed) subLabel = failed;
                    }
                    return (
                      <div
                        key={`${r.providerId}#${r.keyHashPrefix}`}
                        className="quota-peek-row"
                        style={{ padding: '8px 10px', minWidth: 0 }}
                        title={`${r.providerId}${r.label ? ` · ${r.label}` : ''}`}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: 'var(--text-sm)',
                              fontWeight: 'var(--font-semibold)',
                              color: 'var(--text-main)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}
                          >
                            {r.providerId}
                          </span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                            {/* Per-pair refresh, revealed on row hover (opacity,
                                no layout shift): one upstream request instead of
                                the whole directory — same action as the quota
                                page's card footer. */}
                            <button
                              className="quota-peek-refresh"
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                display: 'inline-flex',
                                alignItems: 'center',
                                cursor: 'pointer',
                                color: 'var(--text-dim)',
                              }}
                              disabled={isRefreshing({ providerId: r.providerId, keyHashPrefix: r.keyHashPrefix })}
                              title={t('quotaPage.refreshPair')}
                              aria-label={t('quotaPage.refreshPair')}
                              onClick={() => void refresh({ providerId: r.providerId, keyHashPrefix: r.keyHashPrefix })}
                            >
                              <RefreshCw
                                size={10}
                                style={
                                  isRefreshing({ providerId: r.providerId, keyHashPrefix: r.keyHashPrefix })
                                    ? { animation: 'ocr-spin 0.8s linear infinite' }
                                    : undefined
                                }
                              />
                            </button>
                            {headValue}
                          </span>
                        </div>
                        {pct !== null && (
                          // The meter itself: full row width, so every bar shares
                          // the same track and the fill reads as remaining quota.
                          <div
                            style={{
                              marginTop: '6px',
                              height: '6px',
                              borderRadius: '3px',
                              background: 'var(--chip-bg)',
                              overflow: 'hidden',
                            }}
                          >
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
                        {(subLabel || resetText) && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', marginTop: '4px', minWidth: 0 }}>
                            <span
                              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                              title={subLabel || undefined}
                            >
                              {subLabel}
                            </span>
                            {resetText && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', whiteSpace: 'nowrap', flexShrink: 0 }}>{resetText}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
