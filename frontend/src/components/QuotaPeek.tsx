import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { api, type QuotaOverview, type QuotaWindow } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { fmtDur } from '../lib/format';
import { byQuotaUrgency, headlineWindow } from '../lib/quotaRank';

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
 * and re-fetches whenever the panel opens. The chip lamp mirrors the
 * scarcest headline window across all pairs (rose <10%, amber <25%).
 */

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };

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

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 250);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

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

  // Same urgency-first order as the quota page — the scarcest pair leads.
  const rows = useMemo(() => (data?.pairs ?? []).filter((r) => r.covered).sort(byQuotaUrgency), [data]);

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

  const badgeWord = (badge: string): string =>
    badge === 'probed'
      ? t('quotaPage.stateProbed')
      : badge === 'declared'
        ? t('quotaPage.stateDeclared')
        : badge === 'stale'
          ? t('quotaPage.stateStale')
          : t('quotaPage.stateUnverified');

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
      onMouseEnter={openPanel}
      onMouseLeave={scheduleClose}
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
        <span style={{ ...MONO, fontSize: '11px', fontWeight: 700, color: lamp, whiteSpace: 'nowrap' }}>
          {globalWorst === null ? t('nav.quotaPeekTitle') : `${Math.round(globalWorst)}%`}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            style={{ position: 'fixed', left: pos.left, bottom: pos.bottom, width: '340px', zIndex: 100 }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
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
                  <span style={{ fontSize: '12.5px', fontWeight: 700, letterSpacing: '0.02em', color: 'var(--text-main)' }}>
                    {t('nav.quotaPeekTitle')}
                  </span>
                </span>
                <span
                  style={{
                    ...MONO,
                    fontSize: '10.5px',
                    color: 'var(--text-dim)',
                    border: '1px solid var(--card-border)',
                    borderRadius: '999px',
                    padding: '2px 8px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('quotaPage.sumPairs', { n: rows.length })}
                </span>
              </div>
              {data && !data.enabled && (
                <div style={{ fontSize: '11px', color: 'var(--accent-amber)', padding: '2px 2px 6px' }}>{t('nav.quotaPeekOff')}</div>
              )}
              {rows.length === 0 ? (
                <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', padding: '10px 2px' }}>{t('nav.quotaPeekNoPairs')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
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
                        <span style={{ ...MONO, fontSize: '13px', fontWeight: 700, color: pctColor(pct), flexShrink: 0 }}>
                          {Math.round(pct)}%
                        </span>
                      );
                      subLabel = winLabel(w);
                      if (w.resetAt !== null && w.resetAt > Date.now()) {
                        resetText = t('quotaPage.peekResets', { when: fmtDur(w.resetAt - Date.now()) });
                      }
                    } else if (balance) {
                      const amount = Math.max(0, (balance.total ?? 0) - (balance.used ?? 0));
                      headValue = (
                        <span style={{ ...MONO, fontSize: '13px', fontWeight: 700, color: amount <= 0 ? 'var(--accent-rose)' : 'var(--text-main)', flexShrink: 0 }}>
                          {amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          {balance.nameArg ? <span style={{ fontSize: '10.5px', fontWeight: 500, color: 'var(--text-dim)' }}> {balance.nameArg}</span> : null}
                        </span>
                      );
                      subLabel = winLabel(balance);
                    } else {
                      const badge = r.quota?.badge;
                      headValue = (
                        <span style={{ fontSize: '11px', fontWeight: 600, color: badge === 'stale' ? 'var(--accent-rose)' : 'var(--text-dim)', flexShrink: 0 }}>
                          {badge ? badgeWord(badge) : '—'}
                        </span>
                      );
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
                              fontSize: '12px',
                              fontWeight: 600,
                              color: 'var(--text-main)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}
                          >
                            {r.providerId}
                          </span>
                          {headValue}
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
                              style={{ fontSize: '10.5px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                              title={subLabel || undefined}
                            >
                              {subLabel}
                            </span>
                            {resetText && <span style={{ fontSize: '10.5px', color: 'var(--text-dim)', whiteSpace: 'nowrap', flexShrink: 0 }}>{resetText}</span>}
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
