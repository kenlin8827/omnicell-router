/**
 * Local Model Settings — mirror URL, HuggingFace token and the GGUF storage
 * directory, one card with three labelled fields. Installed engines that have
 * a setup form get a jump link to that form on the engines page: operators
 * look for engine paths here, and the form itself stays with the engine card.
 *
 * Every field resolves as console setting → environment variable → default;
 * the GET response reports where each effective value came from, so each
 * field carries a source badge (page config / env var / default). Saving is a
 * partial PUT: mirror and dir save whatever is in the box ('' = clear and
 * fall back), the token only saves when typed — a small clear button drops it.
 * Changes apply on the next request; no gateway restart.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Gauge, Save, Settings, X } from 'lucide-react';
import {
  api,
  type LocalEngineCatalogRow,
  type LocalModelSettingsResponse,
  type LocalSettingSource,
} from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { FilePickerModal } from '../components/FilePickerModal';

/** Built-in mirror presets, mirroring the reference product's server list:
 *  latency-probed in one click, applied with a per-row button. Only endpoints
 *  that serve the real Hub API surface (search + resolve/main) are listed. */
const MIRROR_PRESETS: { url: string; badgeKey?: 'mirrorOfficial' | 'mirrorChina' }[] = [
  { url: 'https://huggingface.co', badgeKey: 'mirrorOfficial' },
  { url: 'https://hf-mirror.com', badgeKey: 'mirrorChina' },
];

/** Badge showing where the effective value came from. */
const SourceBadge: React.FC<{ source: LocalSettingSource }> = ({ source }) => {
  const { t } = useI18n();
  const key = source === 'setting' ? 'sourceSetting' : source === 'env' ? 'sourceEnv' : 'sourceDefault';
  return (
    <span
      className="badge"
      style={{
        fontSize: 'var(--text-2xs)',
        flexShrink: 0,
        ...(source === 'setting' ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : {}),
      }}
    >
      {t(`localModels.${key}`)}
    </span>
  );
};

const Field: React.FC<{ label: string; hint: string; badge?: React.ReactNode; children: React.ReactNode }> = ({ label, hint, badge, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-main)' }}>{label}</span>
      {badge}
    </div>
    {children}
    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{hint}</span>
  </div>
);

export const LocalSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState<LocalModelSettingsResponse | null>(null);
  /** Installed engines that declare a setup form. The link jumps to that
   *  form; an engine with nothing to configure is not listed. */
  const [installedEngines, setInstalledEngines] = useState<LocalEngineCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mirror, setMirror] = useState('');
  const [token, setToken] = useState('');
  const [dir, setDir] = useState('');
  /** Per-URL probe result: ms, 'fail', undefined = not measured yet. */
  const [latencies, setLatencies] = useState<Record<string, number | 'fail'>>({});
  const [pinging, setPinging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      try {
        const data = await api.getLocalModelSettings();
        setSettings(data);
        setMirror(data.hfEndpointStored);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
      try {
        const catalog = await api.getLocalEngines();
        setInstalledEngines(catalog.engines.filter((engine) => engine.installs.length > 0 && engine.runtime?.setup));
      } catch {
        setInstalledEngines([]);
      }
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Preset rows plus the typed custom URL, so a hand-entered mirror gets the
   *  same probe/apply affordances as the built-ins. */
  const customMirror = mirror.trim().replace(/\/+$/, '');
  const mirrorTargets = customMirror && !MIRROR_PRESETS.some((p) => p.url === customMirror)
    ? [...MIRROR_PRESETS, { url: customMirror }]
    : MIRROR_PRESETS;

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await api.updateLocalModelSettings({
        hfEndpoint: mirror.trim(),
        modelsDir: dir.trim(),
        ...(token.trim() ? { hfToken: token.trim() } : {}),
      });
      toast.success(t('localModels.savedToast'));
      setToken('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [settings, mirror, dir, token, toast, t, load]);

  const clearToken = useCallback(async () => {
    try {
      await api.updateLocalModelSettings({ hfToken: '' });
      toast.success(t('localModels.savedToast'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [toast, t, load]);

  /** Probe every listed URL (presets + typed custom) in parallel. */
  const testLatencies = useCallback(async () => {
    const targets = new Set(mirrorTargets.map((p) => p.url));
    setPinging(true);
    setLatencies((prev) => {
      const next = { ...prev };
      for (const url of targets) delete next[url];
      return next;
    });
    await Promise.all([...targets].map(async (url) => {
      try {
        const r = await api.pingHfMirror(url);
        setLatencies((prev) => ({ ...prev, [url]: r.ok && typeof r.ms === 'number' ? r.ms : 'fail' }));
      } catch {
        setLatencies((prev) => ({ ...prev, [url]: 'fail' }));
      }
    }));
    setPinging(false);
  }, [mirror]);

  /** Apply a preset (or the typed URL) right away — no separate save click. */
  const applyMirror = useCallback(async (url: string) => {
    try {
      await api.updateLocalModelSettings({ hfEndpoint: url });
      setMirror(url);
      toast.success(t('localModels.savedToast'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [toast, t, load]);

  return (
    <div className="pane-section">
      <div className="pane-section-scroll">
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 720 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Settings size={16} style={{ color: 'var(--text-dim)' }} />
              <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{t('localModels.settingsTitle')}</span>
            </div>
            <button className="btn btn-sm btn-primary" style={{ flexShrink: 0 }} onClick={() => void save()} disabled={saving || loading}>
              <Save size={13} />
              <span>{t('localModels.settingsSave')}</span>
            </button>
          </div>

          {installedEngines.length > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: -8 }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{t('localModels.engineSetupTitle')}</span>
              {installedEngines.map((engine) => (
                <Link
                  key={engine.id}
                  to={`/local-models#engine-setup-${encodeURIComponent(engine.id)}`}
                  className="btn"
                  style={{ padding: '2px 8px', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-none)', textDecoration: 'none' }}
                >
                  {engine.name}
                </Link>
              ))}
            </div>
          )}

          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: -10 }}>{t('localModels.settingsSubtitle')}</span>

          <Field
            label={t('localModels.mirrorLabel')}
            hint={t('localModels.mirrorHint')}
            badge={settings ? <SourceBadge source={settings.hfEndpointSource} /> : undefined}
          >
            <input
              className="input"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
              value={mirror}
              onChange={(e) => setMirror(e.target.value)}
              placeholder="https://hf-mirror.com"
              spellCheck={false}
            />
          </Field>

          {/* Mirror presets: one-click latency probe, one-click apply — the
              reference product's download-server list, minus the paid part. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: -10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('localModels.mirrorPresets')}</span>
              <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => void testLatencies()} disabled={pinging}>
                <Gauge size={13} />
                <span>{pinging ? t('localModels.pinging') : t('localModels.pingAction')}</span>
              </button>
            </div>
            <div className="sub-card" style={{ padding: '2px 12px' }}>
              {mirrorTargets.map((preset, index) => {
                const lat = latencies[preset.url];
                const inUse = settings?.hfEndpoint === preset.url;
                return (
                  <div
                    key={preset.url}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderTop: index === 0 ? undefined : '1px dashed var(--divider)' }}
                  >
                    {preset.badgeKey && (
                      <span className="badge" style={{ fontSize: 'var(--text-2xs)', flexShrink: 0 }}>
                        {t(`localModels.${preset.badgeKey}`)}
                      </span>
                    )}
                    <span
                      title={preset.url}
                      style={{ flex: '1 1 auto', minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {preset.url}
                    </span>
                    {lat === 'fail' ? (
                      <span style={{ flexShrink: 0, fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('localModels.pingFailed')}</span>
                    ) : typeof lat === 'number' ? (
                      <span style={{ flexShrink: 0, width: 56, textAlign: 'right', fontSize: 'var(--text-xs)', color: 'var(--accent-emerald)', fontVariantNumeric: 'tabular-nums' }}>
                        {lat} ms
                      </span>
                    ) : null}
                    {inUse ? (
                      <span className="badge" style={{ flexShrink: 0, fontSize: 'var(--text-2xs)', color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                        {t('localModels.mirrorInUse')}
                      </span>
                    ) : (
                      <button className="btn btn-sm" style={{ flexShrink: 0, minWidth: 64, justifyContent: 'center' }} onClick={() => void applyMirror(preset.url)}>
                        {t('localModels.useMirror')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <Field
            label={t('localModels.tokenLabel')}
            hint={t('localModels.tokenHint')}
            badge={settings ? <SourceBadge source={settings.hfTokenSource} /> : undefined}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                className="input"
                type="password"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', flex: 1 }}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={settings?.hfTokenSet ? `${t('localModels.tokenSetPrefix')} ${settings.hfTokenHint}` : 'hf_...'}
                autoComplete="new-password"
              />
              {settings?.hfTokenSet && (
                <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => void clearToken()} title={t('localModels.tokenClear')}>
                  <X size={13} />
                  <span>{t('localModels.tokenClear')}</span>
                </button>
              )}
            </div>
          </Field>

          <Field
            label={t('localModels.dirLabel')}
            hint={t('localModels.dirHint')}
            badge={settings ? <SourceBadge source={settings.modelsDirSource} /> : undefined}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', flex: 1 }}
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder={settings?.defaultModelsDir ?? ''}
                spellCheck={false}
              />
              <button className="btn" style={{ flexShrink: 0 }} onClick={() => setPickerOpen(true)}>
                {t('localModels.browse')}
              </button>
            </div>
          </Field>

          {settings && settings.modelsDir !== settings.defaultModelsDir && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: -12 }}>
              {t('localModels.dirDefaultPrefix')} <code style={{ fontFamily: 'var(--font-mono)' }}>{settings.defaultModelsDir}</code>
            </span>
          )}
        </div>
      </div>
      <FilePickerModal
        open={pickerOpen}
        mode="dir"
        initialPath={dir || settings?.modelsDir}
        onPick={(p) => {
          setDir(p);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
};
