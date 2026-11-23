/**
 * System Proxy — the machine-wide OS proxy and its ONE owner (ADR-0018 /
 * ADR-0022).
 *
 * The OS proxy is not per-endpoint state: it is a single slot that points the
 * whole machine at exactly one OCR endpoint, with a snapshot of the pre-OCR
 * settings for restore. That made it wrong for the inbound page and the Clash
 * page to each carry their own switch — they could silently steal the owner
 * from one another, and the owner copy had to be duplicated in every surface.
 * This page is the ONLY place the pointer can be (re)assigned. The other
 * surfaces keep status and restore: recovering a stale pointer must not
 * require finding this page.
 *
 * The target is an ACTION, never a saved config field: applying rewrites the
 * OS pointer immediately (the backend snapshots first, once, and keeps the
 * pre-OCR payload across switches).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MonitorCog, Undo2, ArrowRight } from 'lucide-react';
import { api, type SystemProxyStatus } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { FONT_MONO } from '../lib/fonts';

type Target = 'forward' | 'clash';

const STATE_KEYS: Record<SystemProxyStatus['state'], string> = {
  on: 'proxyLog.sysStateOn',
  off: 'proxyLog.sysStateOff',
  external: 'proxyLog.sysStateExternal',
  stale: 'proxyLog.sysStateStale',
  unsupported: 'proxyLog.sysStateUnsupported',
};

export const SystemProxyPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [params] = useSearchParams();
  const [sys, setSys] = useState<SystemProxyStatus | null>(null);
  const [busy, setBusy] = useState<Target | 'restore' | null>(null);

  const load = useCallback(async () => {
    try {
      setSys(await api.getSystemProxy());
    } catch {
      // Keep the last known state: a probe blip must not blank the page.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const deepTarget = params.get('target');
  // Deep link from the inbound wizard / the Clash pill: land with the chosen
  // target card in view. Entries themselves are navigation, not view state,
  // and the 5s status poll re-renders with a fresh object — scroll ONCE, or a
  // scroll the operator makes later would be yanked back every five seconds.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!sys || scrolled.current) return;
    if (deepTarget !== 'forward' && deepTarget !== 'clash') return;
    scrolled.current = true;
    requestAnimationFrame(() => {
      document.getElementById(`sp-target-${deepTarget}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [sys, deepTarget]);

  const apply = async (target: Target) => {
    setBusy(target);
    try {
      setSys(await api.enableSystemProxy(target));
    } catch (err: any) {
      const msg = err?.message === 'not-running' ? t('proxyLog.sysClashNeedCore') : err?.message || String(err);
      toast.error(t('proxyLog.sysEnableBtn') + ': ' + msg);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    try {
      setSys(await api.disableSystemProxy());
    } catch (err: any) {
      toast.error(t('proxyLog.sysDisableBtn') + ': ' + (err?.message || err));
    } finally {
      setBusy(null);
    }
  };

  if (!sys) return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;

  const owner = sys.owner;
  const active = (target: Target) => sys.state === 'on' && owner === target;
  const ownedBy = (target: Target) => owner === target && (sys.state === 'on' || sys.state === 'stale');
  const badgeKey = sys.state === 'on' && owner === 'clash' ? 'proxyLog.sysStateOnClash' : STATE_KEYS[sys.state];
  const stateColor = sys.state === 'on'
    ? 'var(--accent-emerald)'
    : sys.state === 'stale' || sys.state === 'external' ? 'var(--accent-amber)' : 'var(--text-dim)';
  const staleHint = owner === 'clash' ? 'proxyLog.sysStaleHintClash' : 'proxyLog.sysStaleHint';

  const cards: {
    target: Target;
    title: string;
    desc: string;
    server: string;
    bypass?: string;
    gateOk: boolean;
    gateHint: string;
    link: string;
    linkLabel: string;
  }[] = [
    {
      target: 'forward',
      title: t('proxyLog.sysForwardTitle'),
      desc: t('proxyLog.sysHint'),
      server: `127.0.0.1:${sys.forward?.port ?? ''}`,
      bypass: sys.override,
      gateOk: sys.forward?.enabled === true,
      gateHint: t('proxyLog.sysForwardOff'),
      link: '/proxy-access',
      linkLabel: t('nav.proxyAccess'),
    },
    {
      target: 'clash',
      title: t('proxyLog.sysClashTitle'),
      desc: t('proxyLog.sysClashHint'),
      server: `127.0.0.1:${sys.clash?.mixedPort ?? ''}`,
      bypass: sys.clash?.override,
      gateOk: sys.clash?.running === true,
      gateHint: t('proxyLog.sysClashNeedCore'),
      link: '/proxy-clash',
      linkLabel: t('nav.proxyMihomo'),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0 }}>
      <div className="card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div className="card-header">
          <div className="card-title">
            <MonitorCog size={18} color="var(--accent)" />
            <span>{t('nav.systemProxy')}</span>
            <span
              className="badge"
              style={{ fontSize: 'var(--text-2xs)', border: '1px solid var(--divider)', color: stateColor, background: 'var(--chip-bg)' }}
            >
              {t(badgeKey)}
            </span>
          </div>
          {sys.supported && (
            <button
              className="btn btn-sm"
              disabled={busy !== null || (sys.state !== 'on' && sys.state !== 'stale')}
              onClick={() => void restore()}
            >
              <Undo2 size={12} />
              <span>{sys.state === 'stale' ? t('proxyLog.sysRestoreBtn') : t('proxyLog.sysDisableBtn')}</span>
            </button>
          )}
        </div>

        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', whiteSpace: 'pre-wrap' }}>
          {t('proxyLog.sysPageIntro')}
        </div>

        {sys.currentServer && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
            <span style={{ marginRight: '6px' }}>{t('proxyLog.sysCurrentLabel')}</span>
            <span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{sys.currentServer}</span>
          </div>
        )}

        {sys.state === 'stale' && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t(staleHint)}</div>
        )}
        {ownedBy('forward') && sys.forward?.enabled === false && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('proxyLog.sysRestoreBarHint')}</div>
        )}
        {ownedBy('clash') && sys.clash?.running === false && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('proxyLog.sysClashCoreDown')}</div>
        )}

        {sys.supported ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
            {cards.map((c) => (
              <div
                key={c.target}
                id={`sp-target-${c.target}`}
                className="sub-card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  border: active(c.target) ? '1px solid var(--accent)' : undefined,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
                    <span style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--font-semibold)' }}>{c.title}</span>
                    {active(c.target) && <span className="badge badge-success">{t('proxyLog.sysActiveBtn')}</span>}
                    {ownedBy(c.target) && sys.state === 'stale' && <span className="badge">{t('proxyLog.sysStateStale')}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <Link to={c.link} className="link-quiet">
                      <span>{c.linkLabel}</span>
                      <ArrowRight size={12} />
                    </Link>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busy !== null || active(c.target) || !c.gateOk}
                      title={!c.gateOk ? c.gateHint : undefined}
                      onClick={() => void apply(c.target)}
                    >
                      <MonitorCog size={12} />
                      <span>
                        {active(c.target)
                          ? t('proxyLog.sysActiveBtn')
                          : sys.state === 'on'
                            ? t('proxyLog.sysSwitchBtn')
                            : t('proxyLog.sysEnableBtn')}
                      </span>
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{c.desc}</div>
                {!c.gateOk && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{c.gateHint}</div>}

                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                  <span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{c.server}</span>
                </div>
                {c.bypass && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    <span style={{ marginRight: '6px' }}>{t('proxyLog.sysOverrideLabel')}</span>
                    <span style={{ fontFamily: FONT_MONO, wordBreak: 'break-all' }}>{c.bypass}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxyLog.sysUnsupportedNote')}</div>
        )}
      </div>
    </div>
  );
};