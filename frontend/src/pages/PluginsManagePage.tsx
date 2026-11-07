import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Puzzle, Trash2, Upload, Power, PowerOff, Settings2 } from 'lucide-react';
import { ScrollTable } from '../components/ScrollTable';
import { Combobox } from '../components/Combobox';
import { Drawer } from '../components/Drawer';
import { Switch } from '../components/Switch';
import { opencodeApi, type PluginConfigFieldInfo, type PluginViewInfo } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { LANG_TO_BCP47 } from '../i18n/languages';
import { useToast } from '../components/ToastProvider';
import { FONT_MONO } from '../lib/fonts';

/**
 * /plugins — OCR plugin management. Plugins are USER-INSTALLED packages
 * (`.zip` in <ocrHome>/plugins, or the untracked dev tree) of either type
 * ('model-service' outbound executors or 'client-gateway' inbound SNI-host
 * gateways, ADR-0017); this page lists what is installed, which type and
 * wires it serves, and whether it loaded. Disable/enable toggles a plugin
 * without deleting anything (works for dev-tree plugins too); uninstall
 * removes packages.
 * Reload re-scans and rebuilds the routing pool so changes apply without a
 * restart.
 * Settings opens the operator-facing config drawer: the backend reports the
 * plugin's flat schema plus its current values (defaults merged), the drawer
 * renders one control per field and PUTs the full values object back.
 */

const HEADER: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '0 0 12px', flexWrap: 'wrap' };
const TITLE: React.CSSProperties = { fontSize: 'var(--text-xl)', fontWeight: 'var(--font-bold)', display: 'flex', alignItems: 'center', gap: 8 };
const CELL: React.CSSProperties = { padding: '7px 10px', verticalAlign: 'middle' };
const CONFIG_KEY: React.CSSProperties = { fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', fontFamily: FONT_MONO };

/**
 * Pick a localized title/desc from a plugin locale map. Same fallback chain as
 * the manifest description column: manifest keys are BCP-47 ('zh-CN'/'en-US')
 * while the UI Lang is the short code ('zh'/'en'), so translate first, then
 * fall back en-US/en, then the first available locale.
 */
function pickLocaleText(text: string | Record<string, string> | undefined, lang: string): string | undefined {
  if (!text) return undefined;
  if (typeof text === 'string') return text;
  const key = LANG_TO_BCP47[lang as keyof typeof LANG_TO_BCP47];
  return text[key] ?? text['en-US'] ?? text['en'] ?? Object.values(text)[0];
}

/** Drawer draft: string/number/enum keep their raw input text, string[] is
 *  newline-joined, booleans stay booleans. Typed conversion happens on save. */
type ConfigDraft = Record<string, string | boolean>;

/** Seed the draft from the merged values the backend returned. */
function buildDraft(schema: PluginConfigFieldInfo[], values: Record<string, unknown>): ConfigDraft {
  const draft: ConfigDraft = {};
  for (const field of schema) {
    const value = values[field.key] ?? field.default;
    if (field.type === 'boolean') draft[field.key] = value === true;
    else if (field.type === 'string[]') draft[field.key] = Array.isArray(value) ? value.map((v) => String(v)).join('\n') : '';
    else draft[field.key] = value === undefined || value === null ? '' : String(value);
  }
  return draft;
}

/** Serialize the draft back to typed values for the PUT body. Every schema key
 *  is sent — the backend expects the FULL values object. */
function buildValues(schema: PluginConfigFieldInfo[], draft: ConfigDraft): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of schema) {
    const raw = draft[field.key];
    if (field.type === 'boolean') {
      values[field.key] = raw === true;
    } else if (field.type === 'string[]') {
      // One entry per line, trimmed, empty lines dropped.
      values[field.key] = String(raw ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } else if (field.type === 'number') {
      const num = Number(raw);
      values[field.key] = raw === '' || Number.isNaN(num) ? (typeof field.default === 'number' ? field.default : 0) : num;
    } else {
      values[field.key] = String(raw ?? '');
    }
  }
  return values;
}

export function PluginsManagePage(): React.ReactElement {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [plugins, setPlugins] = useState<PluginViewInfo[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // Settings drawer state. `configTarget` doubles as the open flag so the
  // drawer mounts empty-then-fills and never renders another plugin's schema.
  const [configTarget, setConfigTarget] = useState<PluginViewInfo | null>(null);
  const [configSchema, setConfigSchema] = useState<PluginConfigFieldInfo[]>([]);
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configWarnings, setConfigWarnings] = useState<string[]>([]);
  const [configSaved, setConfigSaved] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await opencodeApi.listPlugins();
      setPlugins(res.plugins ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const uninstall = async (id: string): Promise<void> => {
    if (!window.confirm(t('pluginPage.uninstallConfirm').replace('{name}', id))) return;
    try {
      const res = await opencodeApi.uninstallPlugin(id);
      setPlugins(res.plugins ?? []);
      toast.success(t('pluginPage.uninstallOk').replace('{name}', id));
    } catch (err) {
      toast.error(`${t('pluginPage.uninstallFail')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const toggle = async (p: PluginViewInfo): Promise<void> => {
    try {
      const res = await opencodeApi.setPluginDisabled(p.id, !p.disabled);
      setPlugins(res.plugins ?? []);
      toast.success(t(p.disabled ? 'pluginPage.enableOk' : 'pluginPage.disableOk').replace('{name}', p.id));
    } catch (err) {
      toast.error(`${t(p.disabled ? 'pluginPage.enableFail' : 'pluginPage.disableFail')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const install = async (file: File): Promise<void> => {
    setInstalling(true);
    try {
      const res = await opencodeApi.installPlugin(await file.arrayBuffer());
      setPlugins(res.plugins ?? []);
      toast.success(t('pluginPage.installOk').replace('{name}', res.id));
    } catch (err) {
      toast.error(`${t('pluginPage.installFail')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstalling(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const reload = async (): Promise<void> => {
    setReloading(true);
    try {
      const res = await opencodeApi.reloadPlugins();
      setPlugins(res.plugins ?? []);
      toast.success(t('pluginPage.reloadOk'));
    } catch (err) {
      toast.error(`${t('pluginPage.reloadFail')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReloading(false);
    }
  };


  /** Open the drawer and load the schema/values. A 404 (disabled/unloaded
   *  plugin) surfaces inline in the drawer body. */
  const openConfig = async (p: PluginViewInfo): Promise<void> => {
    setConfigTarget(p);
    setConfigSchema([]);
    setConfigDraft({});
    setConfigError(null);
    setConfigWarnings([]);
    setConfigSaved(false);
    setConfigLoading(true);
    try {
      const res = await opencodeApi.getPluginConfig(p.id);
      const schema = res.schema ?? [];
      setConfigSchema(schema);
      setConfigDraft(buildDraft(schema, res.values ?? {}));
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigLoading(false);
    }
  };

  const saveConfig = async (): Promise<void> => {
    if (!configTarget) return;
    setConfigSaving(true);
    setConfigError(null);
    setConfigWarnings([]);
    setConfigSaved(false);
    try {
      const res = await opencodeApi.putPluginConfig(configTarget.id, buildValues(configSchema, configDraft));
      setConfigDraft(buildDraft(configSchema, res.values ?? {}));
      setConfigWarnings(res.warnings ?? []);
      setConfigSaved(true);
      toast.success(t('pluginPage.configSaved'));
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigSaving(false);
    }
  };

  const renderConfigField = (field: PluginConfigFieldInfo): React.ReactNode => {
    const label = pickLocaleText(field.title, lang) ?? field.key;
    const hint = pickLocaleText(field.desc, lang);
    const raw = configDraft[field.key];
    const setField = (value: string | boolean): void => setConfigDraft((prev) => ({ ...prev, [field.key]: value }));

    let control: React.ReactNode;
    switch (field.type) {
      case 'boolean':
        control = <Switch checked={raw === true} onChange={setField} ariaLabel={label} />;
        break;
      case 'number':
        control = (
          <input
            className="input"
            type="number"
            value={String(raw ?? '')}
            min={field.min}
            max={field.max}
            onChange={(e) => setField(e.target.value)}
            style={{ width: 180 }}
          />
        );
        break;
      case 'string[]':
        control = (
          <textarea
            className="input"
            value={String(raw ?? '')}
            onChange={(e) => setField(e.target.value)}
            rows={Math.min(8, Math.max(3, String(raw ?? '').split('\n').length))}
            style={{ width: '100%', fontFamily: FONT_MONO, fontSize: 'var(--text-sm)', resize: 'vertical' }}
          />
        );
        break;
      case 'enum':
        control = (
          <Combobox
            value={String(raw ?? '')}
            onChange={setField}
            options={(field.values ?? []).map((v) => ({ value: v, label: v }))}
            placeholder={field.key}
          />
        );
        break;
      default:
        control = <input className="input" value={String(raw ?? '')} onChange={(e) => setField(e.target.value)} style={{ width: '100%' }} />;
    }

    return (
      <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label className="form-label" style={{ marginBottom: 0 }}>
            {label}
          </label>
          {field.type === 'boolean' ? control : null}
        </div>
        {field.type !== 'boolean' ? control : null}
        {label !== field.key ? <div style={CONFIG_KEY}>{field.key}</div> : null}
        {hint ? <div className="form-hint">{hint}</div> : null}
      </div>
    );
  };

  return (
    <>
      <div style={HEADER}>
        <div style={TITLE}>
          <Puzzle size={16} aria-hidden />
          {t('pluginPage.title')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={fileInput}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void install(file);
            }}
          />
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={installing}>
            <Upload size={13} aria-hidden />
            {installing ? t('pluginPage.installing') : t('pluginPage.install')}
          </button>
          <button className="btn" onClick={() => void reload()} disabled={reloading}>
            <RefreshCw size={13} aria-hidden className={reloading ? 'spin' : undefined} />
            {t('pluginPage.reload')}
          </button>
        </div>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('pluginPage.desc')}</p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', margin: '0 0 10px', flexWrap: 'wrap' }}>
        <input
          className="input"
          placeholder={t('pluginPage.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 260 }}
        />
        <div style={{ width: 150 }}>
          <Combobox
            value={statusFilter}
            onChange={setStatusFilter}
            clearable
            options={[
              { value: '', label: t('pluginPage.statusAll') },
              { value: 'loaded', label: t('pluginPage.statusLoaded') },
              { value: 'disabled', label: t('pluginPage.statusDisabled') },
              { value: 'error', label: t('pluginPage.statusError') },
            ]}
          />
        </div>
      </div>
      <ScrollTable
        columns={[
          { key: 'name', label: t('pluginPage.colName'), width: 180 },
          { key: 'version', label: t('pluginPage.colVersion'), width: 80 },
          { key: 'type', label: t('pluginPage.colType'), width: 130 },
          { key: 'wires', label: t('pluginPage.colWires'), width: 120 },
          { key: 'status', label: t('pluginPage.colStatus'), width: 120 },
          { key: 'loadedAt', label: t('pluginPage.colLoadedAt'), width: 110 },
          { key: 'detail', label: t('pluginPage.colDetail') },
          { key: 'actions', label: t('pluginPage.colActions'), align: 'center', width: 290 },
        ]}
        empty={loading ? t('common.loading') : (query || statusFilter) ? t('pluginPage.noMatch') : t('pluginPage.empty')}
      >
        {plugins
          .filter((p) => {
            const q = query.toLowerCase();
            const d = p.description;
            const desc = typeof d === 'string' ? d : Object.values(d ?? {}).join(' ');
            if (q && !`${p.name} ${p.version} ${desc}`.toLowerCase().includes(q)) return false;
            if (statusFilter === 'disabled' && !p.disabled) return false;
            if (statusFilter === 'loaded' && (p.disabled || !p.loaded)) return false;
            if (statusFilter === 'error' && (p.disabled || p.loaded)) return false;
            return true;
          })
          .map((p) => (
          <tr key={p.id}>
            <td style={{ ...CELL, fontWeight: 'var(--font-semibold)' }}>{p.name}</td>
            <td style={{ ...CELL, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)' }}>{p.version}</td>
            <td style={CELL}>{p.type === 'client-gateway' ? t('pluginPage.typeClientGateway') : t('pluginPage.typeModelService')}</td>
            <td style={{ ...CELL, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)' }}>{p.wires.join(', ') || '—'}</td>
            <td style={CELL}>
              <span className={`badge ${p.disabled ? 'badge-warning' : p.loaded ? 'badge-success' : 'badge-danger'}`}>
                {p.disabled ? t('pluginPage.statusDisabled') : p.loaded ? t('pluginPage.statusLoaded') : t('pluginPage.statusError')}
              </span>
            </td>
            <td style={{ ...CELL, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)' }}>
              {p.loaded && p.loadedAt ? new Date(p.loadedAt).toLocaleTimeString() : '—'}
            </td>
            <td style={{ ...CELL, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {p.error ?? (
                <span title={`${p.source === 'dev' ? t('pluginPage.sourceDev') : t('pluginPage.sourcePackaged')} · ${p.path}`}>
                  {/* Manifest locale maps key by BCP-47 ('zh-CN'/'en-US'); the UI
                      Lang is the short code ('zh'/'en') — pickLocaleText translates
                      before lookup, then falls back en-US/en. */}
                  {pickLocaleText(p.description, lang) ??
                    `${p.source === 'dev' ? t('pluginPage.sourceDev') : t('pluginPage.sourcePackaged')} · ${p.path}`}
                </span>
              )}
            </td>
            <td style={CELL}>
              {/* Row-level actions use the compact button size — a full-height .btn inside a
                  7px-padded cell pushes the row past every other management table.
                  flex containers ignore text-align, so the button row centers itself. */}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button
                  className={p.disabled ? 'btn btn-sm btn-success' : 'btn btn-sm btn-warning'}
                  onClick={() => void toggle(p)}
                  title={p.disabled ? t('pluginPage.enable') : t('pluginPage.disable')}
                >
                  {p.disabled ? <Power size={12} aria-hidden /> : <PowerOff size={12} aria-hidden />}
                  {p.disabled ? t('pluginPage.enable') : t('pluginPage.disable')}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void openConfig(p)}
                  title={t('pluginPage.settings')}
                >
                  <Settings2 size={12} aria-hidden />
                  {t('pluginPage.settings')}
                </button>
                {p.source === 'packaged' ? (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void uninstall(p.id)}
                    title={t('pluginPage.uninstall')}
                  >
                    <Trash2 size={12} aria-hidden />
                    {t('pluginPage.uninstall')}
                  </button>
                ) : null}
              </div>
            </td>
          </tr>
        ))}
      </ScrollTable>
      {configTarget ? (
        <Drawer
          title={
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Settings2 size={17} aria-hidden />
              <span>{t('pluginPage.configTitle')}</span>
            </span>
          }
          subtitle={`${configTarget.name} · ${configTarget.version}`}
          onClose={() => setConfigTarget(null)}
          closeLabel={t('common.close')}
          width="min(520px, 94vw)"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfigTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveConfig()}
                disabled={configSaving || configLoading || configError !== null}
              >
                {t('pluginPage.configSave')}
              </button>
            </>
          }
        >
          {configLoading ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
          ) : configError !== null ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>
              {t('pluginPage.configInvalid')}: {configError}
            </div>
          ) : (
            <>
              {configSchema.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('pluginPage.configEmpty')}</div>
              ) : (
                configSchema.map(renderConfigField)
              )}
              {configWarnings.length > 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-amber)' }}>
                  <div style={{ fontWeight: 'var(--font-semibold)' }}>{t('pluginPage.configWarnings')}</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {configWarnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {configSaved && configWarnings.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-emerald)' }}>{t('pluginPage.configSaved')}</div>
              ) : null}
            </>
          )}
        </Drawer>
      ) : null}
    </>
  );
}
