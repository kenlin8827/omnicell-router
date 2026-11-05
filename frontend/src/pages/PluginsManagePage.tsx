import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Puzzle, Trash2, Upload, Power, PowerOff } from 'lucide-react';
import { ScrollTable } from '../components/ScrollTable';
import { Combobox } from '../components/Combobox';
import { opencodeApi, type PluginViewInfo } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { LANG_TO_BCP47 } from '../i18n/languages';
import { useToast } from '../components/ToastProvider';
import { FONT_MONO } from '../lib/fonts';

/**
 * /plugins — OCR plugin management. Plugins are USER-INSTALLED
 * model-service packages (`.zip` in <ocrHome>/plugins, or the untracked
 * dev tree); this page lists what is installed, which wires it serves, and
 * whether it loaded. Disable/enable toggles a plugin without deleting
 * anything (works for dev-tree plugins too); uninstall removes packages.
 * Reload re-scans and rebuilds the routing pool so changes apply without a
 * restart.
 */

const HEADER: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '0 0 12px', flexWrap: 'wrap' };
const TITLE: React.CSSProperties = { fontSize: 'var(--text-xl)', fontWeight: 'var(--font-bold)', display: 'flex', alignItems: 'center', gap: 8 };
const CELL: React.CSSProperties = { padding: '7px 10px', verticalAlign: 'middle' };

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

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
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
    } catch {
      toast.error(t('pluginPage.reloadFail'));
    } finally {
      setReloading(false);
    }
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
          { key: 'detail', label: t('pluginPage.colDetail') },
          { key: 'toggle', label: '', width: 110 },
          { key: 'actions', label: '', width: 110 },
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
            <td style={CELL}>{t('pluginPage.typeModelService')}</td>
            <td style={{ ...CELL, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)' }}>{p.wires.join(', ') || '—'}</td>
            <td style={CELL}>
              <span className={`badge ${p.disabled ? 'badge-warning' : p.loaded ? 'badge-success' : 'badge-danger'}`}>
                {p.disabled ? t('pluginPage.statusDisabled') : p.loaded ? t('pluginPage.statusLoaded') : t('pluginPage.statusError')}
              </span>
            </td>
            <td style={{ ...CELL, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
              {p.error ?? (
                <span title={`${p.source === 'dev' ? t('pluginPage.sourceDev') : t('pluginPage.sourcePackaged')} · ${p.path}`}>
                  {(() => {
                    const d = p.description;
                    // Manifest locale maps key by BCP-47 ('zh-CN'/'en-US'); the UI
                    // Lang is the short code ('zh'/'en') — LANG_TO_BCP47 translates
                    // before lookup, then fall back en-US/en.
                    const key = LANG_TO_BCP47[lang];
                    const text = typeof d === 'string' ? d : (d?.[key] ?? d?.['en-US'] ?? d?.['en'] ?? Object.values(d ?? {})[0]);
                    return text ?? `${p.source === 'dev' ? t('pluginPage.sourceDev') : t('pluginPage.sourcePackaged')} · ${p.path}`;
                  })()}
                </span>
              )}
            </td>
            <td style={CELL}>
              <button
                className={p.disabled ? 'btn btn-success' : 'btn btn-warning'}
                onClick={() => void toggle(p)}
                title={p.disabled ? t('pluginPage.enable') : t('pluginPage.disable')}
              >
                {p.disabled ? <Power size={13} aria-hidden /> : <PowerOff size={13} aria-hidden />}
                {p.disabled ? t('pluginPage.enable') : t('pluginPage.disable')}
              </button>
            </td>
            <td style={CELL}>
              {p.source === 'packaged' ? (
                <button
                  className="btn btn-danger"
                  onClick={() => void uninstall(p.id)}
                  title={t('pluginPage.uninstall')}
                >
                  <Trash2 size={13} aria-hidden />
                  {t('pluginPage.uninstall')}
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </ScrollTable>
    </>
  );
}
