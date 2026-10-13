import React, { useState, useEffect } from 'react';
import { Sliders, Save, Check, Globe, HardDrive, Orbit, Archive, ShieldCheck, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import type { WebAuthConfigView } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';

export const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);

  // Console webAuth (dedicated endpoints, NOT part of the whole-config save —
  // the password is hashed server-side and never round-trips through the UI)
  const [waConfig, setWaConfig] = useState<WebAuthConfigView | null>(null);
  const [waEnabled, setWaEnabled] = useState(false);
  const [waUsername, setWaUsername] = useState('');
  const [waPassword, setWaPassword] = useState('');
  const [waPassword2, setWaPassword2] = useState('');
  const [waSaving, setWaSaving] = useState(false);

  useEffect(() => {
    api.getConfig().then(data => {
      setConfig(data);
      setLoading(false);
    }).catch(console.error);
    api.getWebAuthConfig().then(res => {
      setWaConfig(res.webAuth);
      setWaEnabled(res.webAuth.enabled);
      setWaUsername(res.webAuth.username);
    }).catch(console.error);
  }, []);

  const handleWebAuthSave = async () => {
    if (!waConfig || waSaving) return;
    try {
      if (waEnabled && waPassword === '' && !waConfig.hasPassword) {
        toast.error(t('settings.waPasswordRequired'));
        return;
      }
      if (waEnabled && waPassword !== '') {
        if (waPassword !== waPassword2) {
          toast.error(t('settings.waMismatch'));
          return;
        }
        if (waPassword.length < 6) {
          toast.error(t('settings.waTooShort'));
          return;
        }
      }
      setWaSaving(true);
      await api.updateWebAuthConfig({
        enabled: waEnabled,
        username: waUsername.trim(),
        ...(waPassword !== '' ? { password: waPassword } : {}),
      });
      if (waEnabled && waPassword !== '') {
        // Silent self-login: the gate just activated and this browser has no
        // session cookie yet — without it the reload below would lock us out.
        try {
          await api.login(waUsername.trim(), waPassword);
        } catch { /* the login screen will simply show after reload */ }
      }
      toast.success(t('settings.waSaved'));
      window.location.reload();
    } catch (err: any) {
      toast.error(err?.message || t('common.saveFailed'));
    } finally {
      setWaSaving(false);
    }
  };

  const handleWebAuthLogout = async () => {
    const ok = await confirmDialog({
      title: t('settings.waLogoutConfirmTitle'),
      description: t('settings.waLogoutConfirmDesc'),
      confirmLabel: t('settings.waLogout'),
    });
    if (!ok) return;
    try {
      await api.logout();
    } finally {
      window.location.reload();
    }
  };

  const handleSave = async () => {
    try {
      await api.saveConfig(config);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  if (loading || !config) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  // requestCapture master gates the whole System One sub-group; the System
  // One surface master (`enabled`) additionally gates the L2 decision
  // sub-switch. Dim (never disable) so the operator can pre-set in one save.
  const captureOn = config.requestCapture?.enabled ?? false;
  const systemoneOn = config.requestCapture?.systemone?.enabled ?? true;

  // saveConfig posts the whole config and the backend shallow-merges each
  // top-level section, so every write rebuilds the COMPLETE requestCapture
  // node: defaults first, current section next, changed key LAST. Anything
  // left out of the object literal is dropped server-side.
  // (config is untyped `any` page-wide — api.getConfig returns the raw
  // RouterConfig envelope; see frontend/src/lib/api.ts.)
  const patchRequestCapture = (patch: Record<string, unknown>) => setConfig({
    ...config,
    requestCapture: {
      retentionDays: 7,
      maxTotalMB: 512,
      maxBodyBytes: 65536,
      ...(config.requestCapture || {}),
      ...patch,
    },
  });
  // Same rule one level down: `systemone` is a nested node, so replace it
  // whole (both keys default to on, matching the backend defaults; anything
  // omitted from the literal is dropped server-side).
  const patchSystemone = (patch: Record<string, unknown>) => patchRequestCapture({
    systemone: {
      enabled: true,
      l2DecisionEnabled: true,
      ...(config.requestCapture?.systemone || {}),
      ...patch,
    },
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Sliders size={18} color="var(--accent)" />
            <span>{t('settings.title')}</span>
          </div>
          <button className="btn btn-primary" onClick={handleSave}>
            <Save size={14} />
            <span>{t('settings.saveBtn')}</span>
          </button>
        </div>

        {savedNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{t('settings.savedNotice')}</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
          {/* Section 1: Server & Network */}
          <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Globe size={14} />
              {t('settings.netTitle')}
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.port')}</label>
              <input
                type="number"
                value={config.port || 3000}
                onChange={e => setConfig({ ...config, port: parseInt(e.target.value) || 3000 })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.host')}</label>
              <input
                type="text"
                value={config.host || '0.0.0.0'}
                onChange={e => setConfig({ ...config, host: e.target.value })}
                className="input"
              />
            </div>
          </div>

          {/* Section 2: Semantic Cache */}
          <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <HardDrive size={14} />
              {t('settings.cacheTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.cacheEnable')}</span>
              <Switch
                checked={config.cache?.enabled ?? true}
                onChange={v => setConfig({ ...config, cache: { ...config.cache, enabled: v } })}
              />
            </label>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.cacheSim')}</label>
              <input
                type="number"
                step="0.05"
                value={config.cache?.similarityThreshold || 0.85}
                onChange={e => setConfig({ ...config, cache: { ...config.cache, similarityThreshold: parseFloat(e.target.value) || 0.85 } })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.cacheTtl')}</label>
              <input
                type="number"
                value={config.cache?.ttlSeconds || 3600}
                onChange={e => setConfig({ ...config, cache: { ...config.cache, ttlSeconds: parseInt(e.target.value) || 3600 } })}
                className="input"
              />
            </div>
          </div>

          {/* Section 3: Data Flywheel */}
          <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Orbit size={14} />
              {t('settings.flywheelTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.flywheelEnable')}</span>
              <Switch
                checked={config.flywheel?.enabled ?? true}
                onChange={v => setConfig({ ...config, flywheel: { ...config.flywheel, enabled: v } })}
              />
            </label>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.flywheelPath')}</label>
              <input
                type="text"
                value={config.flywheel?.datasetPath || './data/flywheel.jsonl'}
                onChange={e => setConfig({ ...config, flywheel: { ...config.flywheel, datasetPath: e.target.value } })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.flywheelRetentionDays')}</label>
              <input
                type="number"
                min={0}
                value={config.flywheel?.retentionDays ?? 0}
                onChange={e => setConfig({ ...config, flywheel: { ...config.flywheel, retentionDays: parseInt(e.target.value) || 0 } })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.flywheelMaxFileSizeMB')}</label>
              <input
                type="number"
                min={0}
                value={config.flywheel?.maxFileSizeMB ?? 0}
                onChange={e => setConfig({ ...config, flywheel: { ...config.flywheel, maxFileSizeMB: parseInt(e.target.value) || 0 } })}
                className="input"
              />
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('settings.flywheelRestartHint')}
            </div>
          </div>

          {/* Section 4: Request Capture (hot-applied — no restart needed) */}
          <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Archive size={14} />
              {t('settings.capTitle')}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' }}>
              <span>{t('settings.capEnable')}</span>
              <Switch
                checked={config.requestCapture?.enabled ?? false}
                onChange={v => patchRequestCapture({ enabled: v })}
              />
            </label>

            {/* System One sub-group: `enabled` is the surface master — off
                silences both capture legs. The L2 decision sub-switch is
                effective only while it is on. Inactive rows render dimmed,
                still clickable (pre-set pattern). */}
            <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontWeight: 700, fontSize: '12px', color: 'var(--text-main)' }}>
                {t('settings.capSystemoneGroup')}
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer', color: captureOn ? undefined : 'var(--text-dim)' }}>
                  <span>{t('settings.capSystemoneEnable')}</span>
                  <Switch
                    checked={systemoneOn}
                    onChange={v => patchSystemone({ enabled: v })}
                  />
                </label>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                  {t('settings.capSystemoneHint')}
                </div>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer', color: (captureOn && systemoneOn) ? undefined : 'var(--text-dim)' }}>
                  <span>{t('settings.capL2DecisionEnable')}</span>
                  <Switch
                    checked={config.requestCapture?.systemone?.l2DecisionEnabled ?? true}
                    onChange={v => patchSystemone({ l2DecisionEnabled: v })}
                  />
                </label>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                  {t('settings.capL2DecisionHint')}
                </div>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capRetention')}</label>
              <input
                type="number"
                min="1"
                value={config.requestCapture?.retentionDays ?? 7}
                onChange={e => patchRequestCapture({ retentionDays: parseInt(e.target.value) || 7 })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capMaxTotal')}</label>
              <input
                type="number"
                min="1"
                value={config.requestCapture?.maxTotalMB ?? 512}
                onChange={e => patchRequestCapture({ maxTotalMB: parseInt(e.target.value) || 512 })}
                className="input"
              />
            </div>
            <div>
              <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{t('settings.capMaxBody')}</label>
              <input
                type="number"
                min="1024"
                step="1024"
                value={config.requestCapture?.maxBodyBytes ?? 65536}
                onChange={e => patchRequestCapture({ maxBodyBytes: parseInt(e.target.value) || 65536 })}
                className="input"
              />
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
              {t('settings.capPrivacyHint')}
              <br />
              {t('settings.capHotHint')}
            </div>
          </div>
        </div>
      </div>

      {/* Console Access (webAuth) — dedicated save flow, see handleWebAuthSave */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <ShieldCheck size={18} color="var(--accent)" />
            <span>{t('settings.waTitle')}</span>
          </div>
          <button className="btn btn-primary" onClick={handleWebAuthSave} disabled={waSaving || !waConfig}>
            <Save size={14} />
            <span>{t('settings.waSave')}</span>
          </button>
        </div>

        {!waConfig ? (
          <div style={{ color: 'var(--text-dim)', fontSize: '13px' }}>…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px' }}>
              <span>{t('settings.waEnable')}</span>
              <Switch
                checked={waEnabled}
                disabled={waConfig.forced}
                onChange={v => setWaEnabled(v)}
              />
            </label>

            {waConfig.forced && (
              <div style={{ fontSize: '12px', color: 'var(--accent-amber, #f59e0b)', lineHeight: 1.6 }}>
                {t('settings.waForcedHint')}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('settings.waUsername')}
                </label>
                <input
                  type="text"
                  value={waUsername}
                  onChange={e => setWaUsername(e.target.value)}
                  placeholder="admin"
                  className="input"
                />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('settings.waNewPassword')}
                </label>
                <input
                  type="password"
                  value={waPassword}
                  onChange={e => setWaPassword(e.target.value)}
                  placeholder={waConfig.hasPassword ? t('settings.waKeepPassword') : '••••••'}
                  autoComplete="new-password"
                  className="input"
                />
              </div>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>
                  {t('settings.waConfirm')}
                </label>
                <input
                  type="password"
                  value={waPassword2}
                  onChange={e => setWaPassword2(e.target.value)}
                  disabled={waPassword === ''}
                  autoComplete="new-password"
                  className="input"
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                {t('settings.waHint')}
              </div>
              {waConfig.active && (
                <button className="btn btn-sm" onClick={handleWebAuthLogout}>
                  <LogOut size={13} />
                  <span>{t('settings.waLogout')}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
