import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, RefreshCw, Puzzle, ScrollText, Trash2, Upload, Power, PowerOff, Settings2 } from 'lucide-react';
import { ScrollTable } from '../components/ScrollTable';
import { Combobox } from '../components/Combobox';
import { Drawer } from '../components/Drawer';
import { Prose } from '../components/Prose';
import { PluginConfigDrawer } from '../components/PluginConfigDrawer';
import { opencodeApi, type PluginViewInfo } from '../lib/api';
import { isDesktopShell } from '../lib/download';
import { startDownload } from '../lib/download-manager';
import { useI18n } from '../i18n/I18nContext';
import { pickLocaleText } from '../lib/plugin-config';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { FONT_MONO } from '../lib/fonts';

/**
 * /plugins — OCR plugin management. Plugins are USER-INSTALLED packages
 * (`.zip` in <ocrHome>/plugins, or the untracked dev tree) of either type
 * ('model-service' outbound executors or 'client-gateway' inbound SNI-host
 * gateways, ADR-0017); this page lists what is installed, which type and
 * wires it serves, and whether it loaded. Disable/enable toggles a plugin
 * without deleting anything (works for dev-tree plugins too); uninstall
 * removes the package, its settings and every provider def it registered
 * (credentials survive — they are operator state, not plugin state); Download
 * exports an installable package (a dev-tree plugin is zipped on the fly by
 * the backend).
 * Reload re-scans and rebuilds the routing pool so changes apply without a
 * restart.
 * Settings opens the operator-facing config drawer (`PluginConfigDrawer`, shared
 * with the Cursor client card so the editor exists once): the backend reports
 * the plugin's flat schema plus its current values (defaults merged), the drawer
 * renders one control per field and PUTs the full values object back.
 */

const HEADER: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '0 0 12px', flexWrap: 'wrap' };

const TITLE: React.CSSProperties = { fontSize: 'var(--text-xl)', fontWeight: 'var(--font-bold)', display: 'flex', alignItems: 'center', gap: 8 };
const CELL: React.CSSProperties = { padding: '7px 10px', verticalAlign: 'middle' };
/** Description cell: three lines, then ellipsis (full text on hover). Unclamped,
 *  one long manifest turns its row into a scroll of its own. */
const DETAIL_CLAMP: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  marginTop: 2,
  fontSize: 'var(--text-xs)',
  fontWeight: 'var(--font-regular)',
  color: 'var(--text-dim)',
  lineHeight: 'var(--leading-normal)',
};

export function PluginsManagePage(): React.ReactElement {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [plugins, setPlugins] = useState<PluginViewInfo[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  /** Settings drawer target. Non-null mounts the shared drawer, which loads the
   *  plugin's schema/values itself. */
  const [configTarget, setConfigTarget] = useState<PluginViewInfo | null>(null);
  /** Changelog drawer target: the manifest's declared release history. */
  const [changelogTarget, setChangelogTarget] = useState<PluginViewInfo | null>(null);

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
    // Uninstall is destructive BEYOND the package: it deletes the plugin's
    // settings and every provider def it registered (including models that were
    // auto-pulled), so the confirmation names the full scope.
    const ok = await confirmDialog({
      title: t('pluginPage.uninstallConfirm').replace('{name}', id),
      description: t('pluginPage.uninstallConfirmDetail'),
      danger: true,
      confirmLabel: t('pluginPage.uninstall'),
    });
    if (!ok) return;
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

  /** One picker, N packages: the install endpoint takes a single .zip body
   *  (per-package rollback included), so a batch is N sequential uploads. A
   *  failed package must not swallow the rest — collect its reason and keep
   *  going, then report the failures in one toast. */
  const install = async (files: File[]): Promise<void> => {
    setInstalling(true);
    const failures: string[] = [];
    try {
      for (const file of files) {
        try {
          const res = await opencodeApi.installPlugin(await file.arrayBuffer());
          setPlugins(res.plugins ?? []);
          // An engine-refused package still answers 200 (it lands as a
          // DISABLED row), so the green toast must be gated on the refusal
          // flag — a green "installed" over a red row is the one reading an
          // operator must not be left with.
          if (res.incompatible) {
            failures.push(`${file.name}: ${res.error ?? res.id}`);
          } else {
            toast.success(t('pluginPage.installOk').replace('{name}', res.id));
          }
        } catch (err) {
          // A refused install still changed the list (an incompatible package
          // lands as a disabled row), so take its rows before reporting why.
          const rows = (err as { plugins?: PluginViewInfo[] }).plugins;
          if (rows) setPlugins(rows);
          failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      setInstalling(false);
      if (fileInput.current) fileInput.current.value = '';
    }
    if (failures.length > 0) {
      toast.error(`${t('pluginPage.installFail')}: ${failures.join('; ')}`);
    }
  };

  const download = async (id: string): Promise<void> => {
    const result = await startDownload({
      url: opencodeApi.pluginPackageUrl(id),
      name: `${id}.zip`,
      fallbackName: `${id}.zip`,
    });
    if (result.ok) {
      // The desktop panel already shows progress/status/path; only the
      // browser console (which has its own download UI) needs a toast.
      if (!isDesktopShell()) toast.success(t('pluginPage.downloadOk'));
    } else if (!result.canceled) {
      toast.error(`${t('pluginPage.downloadFail')}: ${result.error ?? ''}`);
    }
  };

  const reload = async (): Promise<void> => {
    setReloading(true);
    try {
      const res = await opencodeApi.reloadPlugins();
      setPlugins(res.plugins ?? []);
      // A no-op reload and a repaired one both "succeed" — name what changed,
      // or the operator cannot tell a dead preset def from a working one.
      if (res.registered?.length) {
        toast.success(t('pluginPage.reloadRegistered').replace('{names}', res.registered.join(', ')));
      } else {
        toast.success(t('pluginPage.reloadOk'));
      }
    } catch (err) {
      toast.error(`${t('pluginPage.reloadFail')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReloading(false);
    }
  };

  // `/plugins?plugin=cursor-gateway` (a fallback link on the client card) opens
  // that plugin's settings drawer without duplicating the model editor here.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const id = searchParams.get('plugin');
    if (!id || plugins.length === 0) return;
    const target = plugins.find((plugin) => plugin.id === id);
    // Drop only this deep-link param; other filters/bookmarks keep theirs.
    const next = new URLSearchParams(searchParams);
    next.delete('plugin');
    setSearchParams(next, { replace: true });
    if (target) setConfigTarget(target);
  }, [plugins, searchParams, setSearchParams]);

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
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void install(files);
            }}
          />
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={installing}>
            <Upload size={13} aria-hidden />
            {installing ? t('pluginPage.installing') : t('pluginPage.install')}
          </button>
          <button className="btn" onClick={() => void reload()} disabled={reloading}>
            <RefreshCw size={13} aria-hidden style={reloading ? { animation: 'ocr-spin 0.8s linear infinite' } : undefined} />
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
              { value: 'incompatible', label: t('pluginPage.statusIncompatible') },
              { value: 'error', label: t('pluginPage.statusError') },
            ]}
          />
        </div>
      </div>
      <ScrollTable
        columns={[
          // The description lives UNDER the name in the same cell instead of owning a
          // column: as its own column it was the one width-less track in a
          // `table-layout: fixed` table whose seven declared widths already summed
          // past the viewport, so it collapsed to 0px and every description wrapped
          // one word per line (1158px rows). Stacking also puts the text where it is
          // read — the name column is the one track that absorbs leftover width.
          { key: 'name', label: t('pluginPage.colName') },
          { key: 'version', label: t('pluginPage.colVersion'), width: 80 },
          { key: 'type', label: t('pluginPage.colType'), width: 190 },
          { key: 'status', label: t('pluginPage.colStatus'), width: 140 },
          { key: 'actions', label: t('pluginPage.colActions'), align: 'center', width: 540 },
        ]}
        minWidth={1080}
        empty={loading ? t('common.loading') : (query || statusFilter) ? t('pluginPage.noMatch') : t('pluginPage.empty')}
      >
        {plugins
          .filter((p) => {
            const q = query.toLowerCase();
            const d = p.description;
            const desc = typeof d === 'string' ? d : Object.values(d ?? {}).join(' ');
            if (q && !`${p.name} ${p.version} ${desc}`.toLowerCase().includes(q)) return false;
            // `incompatible` rows are ALSO disabled, so the disabled bucket must
            // exclude them or the same row answers two filters.
            if (statusFilter === 'incompatible' && !p.incompatible) return false;
            if (statusFilter === 'disabled' && (!p.disabled || p.incompatible)) return false;
            if (statusFilter === 'loaded' && (p.disabled || !p.loaded)) return false;
            if (statusFilter === 'error' && (p.disabled || p.loaded)) return false;
            return true;
          })
          .map((p) => (
          <tr key={p.id}>
            <td style={CELL}>
              <div style={{ fontWeight: 'var(--font-semibold)' }}>{p.name}</div>
              {/* Error first (an operator scrolling the list needs the reason), then
                  the localized description clamped to two lines; the tooltip keeps
                  the full text plus where the plugin was loaded from. */}
              {p.error ? (
                <div style={{ ...DETAIL_CLAMP, color: 'var(--accent-rose)' }} title={p.error}>
                  {/* A refused package gets the localised ACTION first: the core
                      sentence names which side is behind, but "update the
                      gateway or the plugin" is what the operator has to do. */}
                  {p.incompatible ? (
                    <>
                      {t('pluginPage.incompatibleHint', { version: p.version, name: p.name })}
                      <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
                        {p.error}
                      </div>
                    </>
                  ) : (
                    p.error
                  )}
                </div>
              ) : (
                (() => {
                  const source = `${p.source === 'dev' ? t('pluginPage.sourceDev') : t('pluginPage.sourcePackaged')} · ${p.path}`;
                  // Manifest locale maps key by BCP-47 ('zh-CN'/'en-US'); the UI
                  // Lang is the short code ('zh'/'en') — pickLocaleText translates
                  // before lookup, then falls back en-US/en.
                  const text = pickLocaleText(p.description, lang) ?? source;
                  return (
                    <div style={DETAIL_CLAMP} title={`${text}\n${source}`}>
                      {text}
                    </div>
                  );
                })()
              )}
            </td>
            <td style={{ ...CELL, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)' }}>{p.version}</td>
            <td style={CELL}>
              {/* One label per part (ADR-0028): a package that is both an
                  ingress hook and a gateway must say so here, because the two
                  halves are enabled and observed in different places. */}
              {(p.types?.length ? p.types : [p.type]).map((type, i) => (
                <span key={type}>
                  {i > 0 && <span style={{ color: 'var(--text-dim)' }}>{' + '}</span>}
                  {type === 'client-gateway'
                    ? t('pluginPage.typeClientGateway')
                    : type === 'client-adapter'
                      ? t('pluginPage.typeClientAdapter')
                      : t('pluginPage.typeModelService')}
                </span>
              ))}
              {/* Folded in from its own column: `wires` is set for model-service plugins
                  only, so a dedicated 120px track sat empty on every client-gateway row. */}
              {p.wires.length > 0 && (
                <span
                  title={t('pluginPage.colWires')}
                  style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
                >
                  {' · '}
                  {p.wires.join(', ')}
                </span>
              )}
            </td>
            <td style={CELL}>
              <span
                className={`badge ${p.incompatible ? 'badge-danger' : p.disabled ? 'badge-warning' : p.loaded ? 'badge-success' : 'badge-danger'}`}
                title={
                  p.incompatible ? t('pluginPage.incompatibleHint', { version: p.version, name: p.name }) : undefined
                }
              >
                {p.incompatible
                  ? t('pluginPage.statusIncompatible')
                  : p.disabled
                    ? t('pluginPage.statusDisabled')
                    : p.loaded
                      ? t('pluginPage.statusLoaded')
                      : t('pluginPage.statusError')}
              </span>
              {/* Folded in from its own column for the same reason as `wires`: one
                  timestamp per row does not earn a track. */}
              {p.loaded && p.loadedAt && (
                <div
                  title={t('pluginPage.colLoadedAt')}
                  style={{ marginTop: 2, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}
                >
                  {new Date(p.loadedAt).toLocaleTimeString()}
                </div>
              )}
            </td>
            <td style={CELL}>
              {/* Row-level actions use the compact button size — a full-height .btn inside a
                  7px-padded cell pushes the row past every other management table.
                  flex containers ignore text-align, so the button row centers itself. */}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                {/* No switch on a refused row: `incompatible` comes from the
                    ENGINE gate, so enabling it would change the ledger and
                    nothing else — the remedy is an upgrade, tooltip included. */}
                {p.incompatible ? (
                  <span
                    style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', alignSelf: 'center', maxWidth: 200 }}
                    title={t('pluginPage.incompatibleHint', { version: p.version, name: p.name })}
                  >
                    {t('pluginPage.statusIncompatible')}
                  </span>
                ) : (
                  <button
                    className={p.disabled ? 'btn btn-sm btn-success' : 'btn btn-sm btn-warning'}
                    onClick={() => void toggle(p)}
                    title={p.disabled ? t('pluginPage.enable') : t('pluginPage.disable')}
                  >
                    {p.disabled ? <Power size={12} aria-hidden /> : <PowerOff size={12} aria-hidden />}
                    {p.disabled ? t('pluginPage.enable') : t('pluginPage.disable')}
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => void download(p.id)}
                  title={t('pluginPage.download')}
                >
                  <Download size={12} aria-hidden />
                  {t('pluginPage.download')}
                </button>
                {/* Only a package that declares a history gets the action; an
                    always-present button would open an empty drawer on most rows. */}
                {p.changelog?.length ? (
                  <button
                    className="btn btn-sm"
                    onClick={() => setChangelogTarget(p)}
                    title={t('pluginPage.changelog')}
                  >
                    <ScrollText size={12} aria-hidden />
                    {t('pluginPage.changelog')}
                  </button>
                ) : null}
                <button
                  className="btn btn-sm"
                  onClick={() => setConfigTarget(p)}
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
        <PluginConfigDrawer plugin={configTarget} onClose={() => setConfigTarget(null)} />
      ) : null}
      {changelogTarget ? (
        <Drawer
          title={t('pluginPage.changelogTitle')}
          subtitle={`${changelogTarget.name} · v${changelogTarget.version}`}
          onClose={() => setChangelogTarget(null)}
          closeLabel={t('common.close')}
          width="min(600px, 94vw)"
        >
          {/* Manifest order IS the display order (the author declares newest
              first); the entry matching the installed version is marked so the
              operator does not have to compare version strings by eye. The
              timeline styling lives in styles/index.css (`.plugin-changelog`). */}
          <div className="plugin-changelog">
            {(changelogTarget.changelog ?? []).map((entry) => {
              const notes = pickLocaleText(entry.notes, lang) ?? '';
              const current = entry.version === changelogTarget.version;
              return (
                <article key={entry.version} className="plugin-changelog-entry" data-current={current}>
                  <div className="plugin-changelog-head">
                    <span className="plugin-changelog-version">v{entry.version}</span>
                    {entry.date ? <span className="plugin-changelog-date">{entry.date}</span> : null}
                    {current ? (
                      <span className="badge badge-success plugin-changelog-current">
                        {t('pluginPage.changelogCurrent')}
                      </span>
                    ) : null}
                  </div>
                  <div className="plugin-changelog-notes">
                    <Prose text={notes} markdown open hideToggle bg="transparent" border="transparent" />
                  </div>
                </article>
              );
            })}
          </div>
        </Drawer>
      ) : null}
    </>
  );
}
