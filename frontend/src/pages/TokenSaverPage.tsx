import React, { useState, useEffect } from 'react';
import { Zap, Save, Check, Copy, Loader2 } from 'lucide-react';
import { api, HeadroomSidecarStatus } from '../lib/api';
import { copyToClipboard } from '../lib/format';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';

const CAVEMAN_LEVELS = ['lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-ultra'] as const;

/** Shared spinner style (keyframes in styles/index.css; same pattern as EnvironmentsPage). */
const SIDECAR_SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

interface CompressionShape {
  rtk?: { enabled?: boolean };
  headroom?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
    compressUserMessages?: boolean;
    autoStart?: boolean;
  };
  caveman?: { enabled?: boolean; level?: string };
}

const CmdLine: React.FC<{ cmd: string }> = ({ cmd }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', maxWidth: '440px' }}>
      <code
        style={{
          flex: 1,
          fontSize: '12px',
          padding: '5px 10px',
          borderRadius: '6px',
          background: 'var(--btn-bg)',
          color: 'var(--text-muted)',
          fontFamily: "'JetBrains Mono', Consolas, 'Noto Sans SC', monospace",
          whiteSpace: 'nowrap',
          overflowX: 'auto',
        }}
      >
        {cmd}
      </code>
      <button
        title={copied ? t('tokenSaver.copied') : t('tokenSaver.copy')}
        onClick={async () => {
          if (await copyToClipboard(cmd)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
          color: 'var(--text-dim)',
        }}
      >
        {copied ? <Check size={13} color="var(--accent-emerald)" /> : <Copy size={13} />}
      </button>
    </div>
  );
};

const Section: React.FC<{
  title: string;
  desc: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  enableLabel: string;
  children?: React.ReactNode;
}> = ({ title, desc, enabled, onToggle, enableLabel, children }) => (
  <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
      <span style={{ fontSize: '14px', fontWeight: 600 }}>{title}</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
        <span style={{ color: 'var(--text-dim)' }}>{enableLabel}</span>
        <Switch checked={enabled} onChange={onToggle} />
      </label>
    </div>
    <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: children ? '12px' : 0 }}>
      {desc}
    </div>
    {enabled && children}
  </div>
);

export const TokenSaverPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [compression, setCompression] = useState<CompressionShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sidecar, setSidecar] = useState<HeadroomSidecarStatus | null>(null);
  const [sidecarBusy, setSidecarBusy] = useState<null | 'start' | 'stop'>(null);

  useEffect(() => {
    api.getConfig().then(cfg => {
      setCompression(((cfg as any).compression as CompressionShape) || {});
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveConfig({ compression });
      toast.success(t('tokenSaver.savedNotice'));
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const refreshSidecar = () => {
    api.getHeadroomSidecar().then(setSidecar).catch(() => setSidecar(null));
  };

  useEffect(() => {
    refreshSidecar();
  }, []);

  const handleSidecarStart = async () => {
    setSidecarBusy('start');
    try {
      const r = await api.startHeadroomSidecar();
      if (r.ok) toast.success(t(r.reused ? 'tokenSaver.headroomReused' : 'tokenSaver.headroomStarted'));
      else toast.error(sidecarErrorText(r));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSidecarBusy(null);
      refreshSidecar();
    }
  };

  const handleSidecarStop = async () => {
    setSidecarBusy('stop');
    try {
      const r = await api.stopHeadroomSidecar();
      if (r.ok) toast.success(t('tokenSaver.headroomStopped'));
      else toast.error(sidecarErrorText(r));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSidecarBusy(null);
      refreshSidecar();
    }
  };

  // State-driven sidecar buttons: exactly ONE action is visible at a time —
  // start when not running, stop when running (refused for adopted instances),
  // the spinning one while an operation is in flight.
  const sidecarBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    padding: '3px 10px',
    borderRadius: '6px',
    background: 'var(--btn-bg)',
    border: '1px solid var(--divider)',
    color: 'var(--text)',
    cursor: sidecarBusy ? 'wait' : 'pointer',
  };

  // Backend failures ride machine codes (`HeadroomSidecarErrorCode`); this maps
  // them to localized toast text. The raw English `error` string is the
  // fallback for unknown codes — never shown when the tables are in sync.
  const SIDECAR_ERROR_KEYS: Record<string, string> = {
    'url-missing': 'tokenSaver.headroomErrUrlMissing',
    'not-loopback': 'tokenSaver.headroomErrNotLoopback',
    'spawn-failed': 'tokenSaver.headroomErrSpawnFailed',
    'spawn-exited': 'tokenSaver.headroomErrSpawnExited',
    'not-ready': 'tokenSaver.headroomErrNotReady',
    disabled: 'tokenSaver.headroomErrDisabled',
    'pid-unknown': 'tokenSaver.headroomErrPidUnknown',
    'kill-failed': 'tokenSaver.headroomErrKillFailed',
  };
  const sidecarErrorText = (r: { code?: string | null; error?: string | null }): string =>
    (r.code && SIDECAR_ERROR_KEYS[r.code] ? t(SIDECAR_ERROR_KEYS[r.code]) : r.error) || 'Failed';

  if (loading || !compression) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  const rtk = compression.rtk || {};
  const headroom = compression.headroom || {};
  const headroomBase = (headroom.url || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const caveman = compression.caveman || {};

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Zap size={18} color="var(--accent)" />
          <span>{t('tokenSaver.title')}</span>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          <Save size={14} />
          <span>{t('tokenSaver.saveBtn')}</span>
        </button>
      </div>

      <div style={{ fontSize: '13px', color: 'var(--text)', marginBottom: '6px' }}>
        {t('tokenSaver.subtitle')}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: '16px' }}>
        {t('tokenSaver.hint')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' }}>
        <Section
          title={t('tokenSaver.rtkTitle')}
          desc={t('tokenSaver.rtkDesc')}
          enabled={rtk.enabled ?? false}
          onToggle={v => setCompression({ ...compression, rtk: { ...rtk, enabled: v } })}
          enableLabel={t('tokenSaver.rtkEnable')}
        />

        <Section
          title={t('tokenSaver.headroomTitle')}
          desc={t('tokenSaver.headroomDesc')}
          enabled={headroom.enabled ?? false}
          onToggle={v => setCompression({ ...compression, headroom: { ...headroom, enabled: v } })}
          enableLabel={t('tokenSaver.headroomEnable')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <CmdLine cmd={t('tokenSaver.headroomStepInstall')} />
              <CmdLine cmd={t('tokenSaver.headroomStepRun')} />
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.7 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span>{t('tokenSaver.headroomStepNote')}</span>
                  <a
                    href="https://docs.headroomlabs.ai/docs/quickstart"
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: '11px', color: 'var(--accent)', width: 'fit-content' }}
                  >
                    {t('tokenSaver.headroomDocs')} ↗
                  </a>
                </div>
                <div>{t('tokenSaver.headroomCacheNote')}</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('tokenSaver.headroomSidecarLabel')}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: sidecar?.running ? 'var(--accent-emerald)' : 'var(--text-dim)',
                    flexShrink: 0,
                  }}
                />
                {!sidecar
                  ? t('tokenSaver.headroomStatusChecking')
                  : sidecar.running
                    ? `${t('tokenSaver.headroomStatusRunning')}${sidecar.version ? ` · v${sidecar.version}` : ''}`
                    : t('tokenSaver.headroomStatusStopped')}
              </span>
              {sidecarBusy === 'start' && (
                <button disabled style={sidecarBtnStyle}>
                  <Loader2 size={11} style={SIDECAR_SPIN} />
                  {t('tokenSaver.headroomStartBtn')}
                </button>
              )}
              {sidecarBusy === 'stop' && (
                <button disabled style={sidecarBtnStyle}>
                  <Loader2 size={11} style={SIDECAR_SPIN} />
                  {t('tokenSaver.headroomStopBtn')}
                </button>
              )}
              {!sidecarBusy && (!sidecar || !sidecar.running) && (
                <button onClick={handleSidecarStart} style={sidecarBtnStyle}>
                  {t('tokenSaver.headroomStartBtn')}
                </button>
              )}
              {!sidecarBusy && sidecar?.running && (
                <button onClick={handleSidecarStop} style={sidecarBtnStyle}>
                  {t('tokenSaver.headroomStopBtn')}
                </button>
              )}
              <label
                title={t('tokenSaver.headroomAutoStart')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  marginLeft: 'auto',
                  paddingRight: '8px',
                }}
              >
                <Switch
                  size="sm"
                  checked={headroom.autoStart ?? false}
                  onChange={v => setCompression({ ...compression, headroom: { ...headroom, autoStart: v } })}
                />
                <span>{t('tokenSaver.headroomAutoStartShort')}</span>
              </label>
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                {t('tokenSaver.headroomUrl')}
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <input
                  type="text"
                  placeholder="http://127.0.0.1:8787"
                  value={headroom.url || ''}
                  onChange={e => setCompression({ ...compression, headroom: { ...headroom, url: e.target.value } })}
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <a
                  href={`${headroomBase}/dashboard`}
                  target="_blank"
                  rel="noreferrer"
                  title={headroomBase}
                  style={{ fontSize: '12px', color: 'var(--accent)', whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  {t('tokenSaver.headroomDashboard')} ↗
                </a>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ width: '180px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('tokenSaver.headroomTimeout')}
                </label>
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={headroom.timeoutMs ?? 3000}
                  onChange={e => setCompression({ ...compression, headroom: { ...headroom, timeoutMs: Number(e.target.value) || undefined } })}
                  className="input"
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer', paddingBottom: '8px' }}>
                <Switch
                  size="sm"
                  checked={headroom.compressUserMessages ?? false}
                  onChange={v => setCompression({ ...compression, headroom: { ...headroom, compressUserMessages: v } })}
                />
                <span>{t('tokenSaver.headroomCompressUser')}</span>
              </label>
            </div>
          </div>
        </Section>

        <Section
          title={t('tokenSaver.cavemanTitle')}
          desc={t('tokenSaver.cavemanDesc')}
          enabled={caveman.enabled ?? false}
          onToggle={v => setCompression({ ...compression, caveman: { ...caveman, enabled: v } })}
          enableLabel={t('tokenSaver.cavemanEnable')}
        >
          <div style={{ width: '240px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
              {t('tokenSaver.cavemanLevel')}
            </label>
            <Combobox
              value={caveman.level || 'full'}
              onChange={v => setCompression({ ...compression, caveman: { ...caveman, level: v } })}
              options={CAVEMAN_LEVELS.map(lv => ({ value: lv, label: lv }))}
            />
          </div>
        </Section>
      </div>
    </div>
  );
};
