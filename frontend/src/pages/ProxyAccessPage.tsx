import React, { useState, useEffect } from 'react';
import { ShieldCheck, Save, BookOpen, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { api, type GatewayStatusResponse } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';

/**
 * Proxy Access — the inbound forward proxy (HTTP_PROXY / HTTPS_PROXY server)
 * as a client access method under the Client Access nav group.
 *
 * Layout:
 *  Card 1 — configuration, ALWAYS visible (status chip + enable / port /
 *           bypass form; Export-CA + Save live in the header).
 *  Card 2 — the setup HELP rendered as a wizard: horizontal clickable stepper,
 *           click a step → its content panel shows; prev/next walk the flow.
 * The status chip polls /api/admin/status every 4s: running / failed /
 * enabled-pending-restart / disabled — a failed start stays visible (the
 * gateway itself never fails on it).
 */

interface ForwardProxyShape {
  enabled?: boolean;
  port?: number;
  bypassHosts?: (string | { host: string; viaProxy?: boolean })[];
  viaOutboundProxy?: boolean;
}

const preStyle: React.CSSProperties = {
  margin: '6px 0 0 0',
  padding: '10px 12px',
  borderRadius: '8px',
  background: 'var(--well-bg)',
  border: '1px solid var(--card-border)',
  fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
  fontSize: '11px',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  color: 'var(--text-muted)',
};

const stepCircle = (active: boolean): React.CSSProperties => ({
  width: '24px',
  height: '24px',
  borderRadius: '50%',
  background: active ? 'var(--btn-primary-bg)' : 'var(--surface-hover)',
  color: active ? 'var(--btn-primary-text)' : 'var(--text-dim)',
  fontSize: '12px',
  fontWeight: 700,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

export const ProxyAccessPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [fp, setFp] = useState<ForwardProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<GatewayStatusResponse | null>(null);
  /** Current wizard step id */
  const [step, setStep] = useState('1');
  /** Bypass host rows — per-row egress choice (viaProxy) */
  const [bypassRows, setBypassRows] = useState<{ host: string; viaProxy: boolean }[]>([]);

  useEffect(() => {
    api.getConfig().then(cfg => {
      const fpCfg = ((cfg as any).forwardProxy as ForwardProxyShape) || {};
      setFp(fpCfg);
      setBypassRows(
        (fpCfg.bypassHosts || []).map(e =>
          typeof e === 'string' ? { host: e, viaProxy: false } : { host: e.host || '', viaProxy: e.viaProxy === true }
        )
      );
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Runtime status poll — the chip must reflect a FAILED start (the gateway
  // keeps serving; only the proxy is absent) as clearly as a running one.
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.getStatus()
        .then(s => { if (alive) setStatus(s); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveConfig({
        forwardProxy: {
          ...(fp || {}),
          bypassHosts: bypassRows
            .filter(r => r.host.trim())
            .map(r => (r.viaProxy ? { host: r.host.trim(), viaProxy: true } : r.host.trim())),
        },
      });
      toast.success(t('forwardProxy.savedNotice'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !fp) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  const port = fp.port || 4555;

  // ── status chip ──
  const fpStatus = status?.forwardProxy;
  let dotColor = 'var(--text-dim)';
  let statusText = t('forwardProxy.statusDisabled');
  if (fpStatus?.running) {
    dotColor = 'var(--accent-emerald)';
    statusText = t('forwardProxy.statusRunning', {
      host: fpStatus.host || '127.0.0.1',
      port: String(fpStatus.port ?? port),
      time: fpStatus.startedAt ? new Date(fpStatus.startedAt).toLocaleTimeString() : '—',
    });
  } else if (fpStatus?.error) {
    dotColor = '#f87171';
    statusText = t('forwardProxy.statusError', { error: fpStatus.error });
  } else if (fpStatus?.enabled ?? (fp.enabled ?? false)) {
    dotColor = '#f59e0b';
    statusText = t('forwardProxy.statusRestartPending');
  }

  // ── help wizard steps (content only — configuration lives in the card above) ──
  // Wizard steps (display order — the i18n key numbers are historical: the old
  // "enable proxy" step was removed since enabling lives in the always-visible
  // config card above). Steps: 1 trust CA · 2 point clients · 3 verify.
  const steps: { id: string; title: string; body: React.ReactNode }[] = [
    {
      id: '1',
      title: t('forwardProxy.step2Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep2')}</div>
          <pre style={preStyle}>{t('forwardProxy.helpStep2Code')}</pre>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('forwardProxy.helpStep2Sys')}</div>
        </div>
      ),
    },
    {
      id: '2',
      title: t('forwardProxy.step3Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep3')}</div>
          <pre style={preStyle}>{t('forwardProxy.helpStep3Code', { port })}</pre>
        </div>
      ),
    },
    {
      id: '3',
      title: t('forwardProxy.step4Title'),
      body: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div>{t('forwardProxy.helpStep4')}</div>
          <pre style={preStyle}>{t('forwardProxy.helpStep4Code', { port })}</pre>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('forwardProxy.helpNotes')}</div>
        </div>
      ),
    },
  ];
  const stepIndex = Math.max(0, steps.findIndex(s => s.id === step));
  const active = steps[stepIndex];

  return (
    <>
      {/* Card 1 — configuration, always visible */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <ShieldCheck size={18} color="var(--accent)" />
            <span>{t('forwardProxy.title')}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <a className="btn" href="/api/admin/proxy/ca" download style={{ gap: '6px' }}>
              {t('forwardProxy.caBtn')}
            </a>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Save size={14} />
              <span>{t('forwardProxy.saveBtn')}</span>
            </button>
          </div>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '12px', whiteSpace: 'pre-line' }}>
          {t('forwardProxy.hint')}
        </div>

        {/* Live runtime status chip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: dotColor,
              boxShadow: dotColor !== 'var(--text-dim)' ? `0 0 8px ${dotColor}` : undefined,
              flexShrink: 0,
            }}
          />
          <span>{statusText}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '640px' }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
            <span>{t('forwardProxy.enable')}</span>
            <Switch checked={fp.enabled ?? false} onChange={v => setFp({ ...fp, enabled: v })} />
          </label>

          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('forwardProxy.port')}</label>
            <input
              type="text"
              inputMode="numeric"
              placeholder="4555"
              value={fp.port ?? ''}
              onChange={e => {
                const digits = e.target.value.replace(/[^0-9]/g, '');
                setFp({ ...fp, port: digits === '' ? undefined : parseInt(digits, 10) });
              }}
              className="input"
            />
          </div>

          {/* Bypass hosts — per-row egress choice (direct tunnel vs via outbound proxy) */}
          <div>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('forwardProxy.bypassHosts')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {bypassRows.map((row, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder={t('forwardProxy.pattern')}
                    value={row.host}
                    onChange={e => {
                      const next = [...bypassRows];
                      next[idx] = { ...next[idx], host: e.target.value };
                      setBypassRows(next);
                    }}
                    className="input"
                  />
                  <label
                    title={t('forwardProxy.bypassViaProxyHint')}
                    style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-dim)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    <input
                      type="checkbox"
                      checked={row.viaProxy}
                      onChange={e => {
                        const next = [...bypassRows];
                        next[idx] = { ...next[idx], viaProxy: e.target.checked };
                        setBypassRows(next);
                      }}
                    />
                    {t('forwardProxy.bypassViaProxy')}
                  </label>
                  <button
                    className="btn btn-danger btn-sm"
                    style={{ padding: '4px 8px' }}
                    onClick={() => setBypassRows(bypassRows.filter((_, i) => i !== idx))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start', gap: '6px' }}
                onClick={() => setBypassRows([...bypassRows, { host: '', viaProxy: false }])}
              >
                <Plus size={14} />
                <span>{t('forwardProxy.addPattern')}</span>
              </button>
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
            <span>{t('forwardProxy.viaOutboundProxy')}</span>
            <Switch checked={fp.viaOutboundProxy ?? false} onChange={v => setFp({ ...fp, viaOutboundProxy: v })} />
          </label>
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '-10px' }}>{t('forwardProxy.viaOutboundProxyHint')}</div>

          <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
            {t('forwardProxy.caHint')} · {t('forwardProxy.hostNote')}
          </div>
        </div>
      </div>

      {/* Card 2 — setup help as a clickable wizard */}
      <div className="card" style={{ marginTop: '16px' }}>
        <div className="card-header">
          <div className="card-title">
            <BookOpen size={18} color="var(--accent)" />
            <span>{t('forwardProxy.helpTitle')}</span>
          </div>
        </div>

        {!(fp.enabled ?? false) ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7, maxWidth: '640px' }}>
            {t('forwardProxy.wizardDisabledHint')}
          </div>
        ) : (
          <>
          {/* Horizontal clickable stepper */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px', overflowX: 'auto', paddingBottom: '4px' }}>
          {steps.map((s, i) => {
            const isActive = s.id === active.id;
            return (
              <React.Fragment key={s.id}>
                {i > 0 && <div style={{ width: '56px', height: '1px', background: 'var(--card-border)', flexShrink: 0 }} />}
                <button
                  onClick={() => setStep(s.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 12px 6px 6px',
                    borderRadius: '999px',
                    cursor: 'pointer',
                    background: isActive ? 'var(--chip-bg)' : 'transparent',
                    border: isActive ? '1px solid var(--card-border)' : '1px solid transparent',
                    color: isActive ? 'var(--text-main)' : 'var(--text-muted)',
                    fontSize: '12px',
                    fontWeight: isActive ? 600 : 500,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  <span style={stepCircle(isActive)}>{s.id}</span>
                  <span>{s.title}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Step content panel */}
        <div style={{ minHeight: '140px', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7, maxWidth: '760px' }}>
          {active.body}
        </div>

        {/* Wizard navigation */}
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: '20px', marginTop: '20px', paddingTop: '14px', borderTop: '1px solid var(--divider)' }}>
          <button
            className="btn btn-sm"
            disabled={stepIndex <= 0}
            onClick={() => setStep(steps[Math.max(0, stepIndex - 1)].id)}
            style={{ gap: '6px' }}
          >
            <ChevronLeft size={13} />
            <span>{t('forwardProxy.wizardPrev')}</span>
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{stepIndex + 1} / {steps.length}</span>
          <button
            className="btn btn-sm"
            disabled={stepIndex >= steps.length - 1}
            onClick={() => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)].id)}
            style={{ gap: '6px' }}
          >
            <span>{t('forwardProxy.wizardNext')}</span>
            <ChevronRight size={13} />
          </button>
        </div>
          </>
        )}
      </div>
    </>
  );
};