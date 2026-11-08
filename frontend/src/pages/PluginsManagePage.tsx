import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, ChevronDown, ChevronUp, Maximize2, Puzzle, Trash2, Upload, Power, PowerOff, Settings2 } from 'lucide-react';
import { ScrollTable } from '../components/ScrollTable';
import { Combobox } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { Drawer } from '../components/Drawer';
import { Field } from '../components/Form';
import { SegGroup } from '../components/SegGroup';
import { Switch } from '../components/Switch';
import { api, opencodeApi, type ApiKeyItem, type PluginConfigFieldInfo, type PluginConfigSectionInfo, type PluginViewInfo } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { groupVisibleFields, pickLocaleText } from '../lib/plugin-config';
import { sortModelOptions } from '../lib/model-options';
import { useToast } from '../components/ToastProvider';
import { FONT_MONO } from '../lib/fonts';
import { humanizeKey } from '../lib/format';

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

/** Cursor's model surface is a CLIENT concern and is edited in Client Hub →
 *  Cursor. Keep these keys in the schema (they are the storage contract) but do
 *  not render a second editor here — one source, one editor. */
const CURSOR_CLIENT_FACING_FIELDS = new Set(['model', 'modelListMode', 'models', 'followKeyId', 'catalogReplace']);
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
  fontWeight: 'var(--font-normal)',
  color: 'var(--text-dim)',
  lineHeight: 'var(--leading-normal)',
};
/** The schema key is metadata, not a heading: printing it beside every label
 *  repeated the row it belonged to and turned the form into a wall of
 *  identifiers. It stays reachable on hover because backend warnings
 *  (`'previewBytes' failed number validation`) and
 *  `<pluginsRoot>/config/<id>.json` both speak keys — hiding it outright would
 *  leave those unreferenceable, printing it permanently costs the label row. */
const CONFIG_LABEL: React.CSSProperties = { cursor: 'help' };
const CONFIG_NUMBER: React.CSSProperties = { width: 160 };
/** Multi-line text boxes stay SHORT by default: the drawer is a scan surface,
 *  and a 6-row box per long field pushed everything else off screen. Writing
 *  room comes from the per-field expand editor (`pluginPage.configExpand`) and
 *  from the native drag handle. */
const CONFIG_TEXTAREA: React.CSSProperties = {
  width: '100%',
  fontFamily: FONT_MONO,
  fontSize: 'var(--text-sm)',
  resize: 'vertical',
  minHeight: 66,
};
/** Label row with an optional trailing action (the expand button). */
const CONFIG_LABEL_ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 };
const CONFIG_TEXTAREA_ROWS = 3;
/** Fields are separated by a hairline rule instead of floating on the drawer
 *  body's gap alone, so the label→control→hint group of one field never reads
 *  as part of the next. */
const CONFIG_LIST: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 };
const CONFIG_DIVIDER: React.CSSProperties = { borderTop: '1px solid var(--divider)', paddingTop: 16 };

/** The type-driven default control, used when a field declares no `control`.
 *  Declaring one that cannot drive the field's type is an install-time error,
 *  so this branch never sees a mismatched pair. */
function renderByType(
  field: PluginConfigFieldInfo,
  raw: string | boolean | undefined,
  setField: (value: string | boolean) => void,
  label: string,
  lang: string
): React.ReactNode {
  switch (field.type) {
    case 'boolean':
      return <Switch checked={raw === true} onChange={setField} ariaLabel={label} />;
    case 'number':
      return (
        <input
          className="input"
          type="number"
          value={String(raw ?? '')}
          min={field.min}
          max={field.max}
          onChange={(e) => setField(e.target.value)}
          style={CONFIG_NUMBER}
        />
      );
    case 'string[]':
      return (
        <textarea
          className="input"
          value={String(raw ?? '')}
          onChange={(e) => setField(e.target.value)}
          rows={CONFIG_TEXTAREA_ROWS}
          style={CONFIG_TEXTAREA}
        />
      );
    case 'enum':
      return (
        <Combobox
          value={String(raw ?? '')}
          onChange={setField}
          options={(field.values ?? []).map((v) => ({
            value: v,
            label: pickLocaleText(field.enumLabels?.[v], lang) ?? v,
          }))}
          placeholder={label}
        />
      );
    default:
      return <input className="input" value={String(raw ?? '')} onChange={(e) => setField(e.target.value)} style={{ width: '100%' }} />;
  }
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
  const [configSections, setConfigSections] = useState<PluginConfigSectionInfo[]>([]);
  /** Declared `advanced` sections the operator has opened (id set). Collapsed
   *  is the default: advanced settings keep their values either way. */
  const [openAdvanced, setOpenAdvanced] = useState<Record<string, boolean>>({});
  /** Textarea field opened in the large editor (null = closed). The editor edits
   *  the SAME draft entry, so there is nothing to "apply" on close. */
  const [expandTarget, setExpandTarget] = useState<PluginConfigFieldInfo | null>(null);
  const [configDraft, setConfigDraft] = useState<ConfigDraft>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configWarnings, setConfigWarnings] = useState<string[]>([]);
  const [configSaved, setConfigSaved] = useState(false);
  /** Catalog model refs for the `model` / `models` controls. Loaded once; a
   *  plugin that declares neither control simply never uses it. */
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);

  /** Enabled gateway keys for the `apiKey` control (follow-model-list mode). */
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getApiKeys()
      .then((res) => {
        if (!cancelled) setApiKeys((res.keys ?? []).filter((key) => key.enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listGatewayModels()
      .then((models) => {
        if (cancelled) return;
        // Same ordering as every other model dropdown (auto aliases, combos,
        // then registered ids) -- sortModelOptions is the single ordering rule.
        const sorted = sortModelOptions(models.map((m) => ({ value: m.id, label: m.id, kind: m.kind })));
        setModelOptions(sorted.map((m) => ({ value: m.value, label: m.label ?? m.value })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
    setConfigSections([]);
    setOpenAdvanced({});
    setConfigDraft({});
    setConfigError(null);
    setConfigWarnings([]);
    setConfigSaved(false);
    setConfigLoading(true);
    try {
      const res = await opencodeApi.getPluginConfig(p.id);
      const schema = res.schema ?? [];
      setConfigSchema(schema);
      setConfigSections(res.sections ?? []);
      setConfigDraft(buildDraft(schema, res.values ?? {}));
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfigLoading(false);
    }
  };

  // `/plugins?plugin=cursor` (linked from the client card) opens that plugin's
  // settings drawer without duplicating the model editor on the clients page.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const id = searchParams.get('plugin');
    if (!id || plugins.length === 0) return;
    const target = plugins.find((plugin) => plugin.id === id);
    // Drop only this deep-link param; other filters/bookmarks keep theirs.
    const next = new URLSearchParams(searchParams);
    next.delete('plugin');
    setSearchParams(next, { replace: true });
    if (target) void openConfig(target);
  }, [plugins, searchParams, setSearchParams]);

  const saveConfig = async (): Promise<void> => {
    if (!configTarget) return;
    setConfigSaving(true);
    setConfigError(null);
    setConfigWarnings([]);
    setConfigSaved(false);
    try {
      let draft = configDraft;
      // Follow mode is a SNAPSHOT, exactly like the clients page: the plugin
      // never receives the key secret and core exposes no key-policy lookup to
      // plugins, so the console resolves the key's allowed models here and
      // stores the resulting ids. Re-save after changing the key's policy.
      if (configTarget.id === 'cursor' && draft.modelListMode === 'follow') {
        const keyId = String(draft.followKeyId ?? '');
        if (!keyId) {
          toast.error(t('clients.followNoKey'));
          return;
        }
        const view = await api.getKeyModels(keyId);
        draft = {
          ...draft,
          models: view.models.filter((model) => model.allowed).map((model) => model.id).join('\n'),
        };
      }
      const res = await opencodeApi.putPluginConfig(configTarget.id, buildValues(configSchema, draft));
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
    const declared = pickLocaleText(field.title, lang);
    // A manifest may omit `title` entirely or ship it only for other locales
    // (the BCP-47 map falls through to en-US). Rather than print the raw
    // identifier as a heading, fall back to a spaced-out key; the exact key
    // stays on the label's tooltip, because that is what backend warnings quote
    // and what config/<id>.json stores.
    const label = declared ?? humanizeKey(field.key);
    const hint = pickLocaleText(field.desc, lang);
    const raw = configDraft[field.key];
    const setField = (value: string | boolean): void => setConfigDraft((prev) => ({ ...prev, [field.key]: value }));

    let control: React.ReactNode;
    switch (field.control ?? null) {
      // The closed console widget vocabulary (ADR-0017 §7). A control only
      // overrides HOW the value is edited -- storage, validation and merge stay
      // type-driven, so `model` is still a plain string in config/<id>.json.
      case 'textarea':
        control = (
          <textarea
            className="input"
            value={String(raw ?? '')}
            onChange={(e) => setField(e.target.value)}
            rows={CONFIG_TEXTAREA_ROWS}
            style={CONFIG_TEXTAREA}
          />
        );
        break;
      case 'model':
        control = (
          <Combobox
            value={String(raw ?? '')}
            onChange={setField}
            options={modelOptions}
            placeholder={label}
            clearable
          />
        );
        break;
      case 'models': {
        // Same multi-select the clients page uses for its model list: chips
        // render inside the trigger and picking toggles, so this is one widget
        // with two hosts rather than a second hand-rolled chip wall.
        const picked = String(raw ?? '')
          .split('\n')
          .map((v) => v.trim())
          .filter((v) => v !== '');
        control = (
          <Combobox
            multiple
            value={picked}
            onChange={(next) => setField(next.join('\n'))}
            options={modelOptions}
            placeholder={t('pluginPage.configAddModel')}
            panelMinWidth={360}
          />
        );
        break;
      }
      case 'segmented':
        // A short closed choice (none / custom / follow) as joined buttons --
        // the console's own mode switches, so a 3-way plugin option does not
        // have to masquerade as a dropdown. `enumLabels` supplies the text;
        // a value without a label falls back to the raw value.
        control = (
          <SegGroup
            size="sm"
            value={String(raw ?? '')}
            onChange={setField}
            options={(((field.values as string[] | undefined) ?? []) as string[]).map((value) => ({
              value,
              label: pickLocaleText(field.enumLabels?.[value], lang) ?? value,
            }))}
          />
        );
        break;
      case 'apiKey':
        // Stable key id, never the secret: the label/meta come from the live
        // key list so a rename shows up without touching the stored value.
        control = (
          <Combobox
            value={String(raw ?? '')}
            onChange={setField}
            options={apiKeys.map((key) => ({
              value: key.id,
              label: key.name,
              meta: key.key.length > 12 ? `${key.key.slice(0, 8)}…${key.key.slice(-4)}` : undefined,
            }))}
            placeholder={label}
            clearable
          />
        );
        break;
      default:
        control = renderByType(field, raw, setField, label, lang);
    }

    return (
      <Field
        label={
          <span style={CONFIG_LABEL_ROW}>
            <span style={CONFIG_LABEL} title={label === field.key ? undefined : field.key}>
              {label}
            </span>
            {field.control === 'textarea' ? (
              <button
                type="button"
                className="btn btn-sm btn-icon"
                title={t('pluginPage.configExpand')}
                aria-label={t('pluginPage.configExpand')}
                onClick={() => setExpandTarget(field)}
              >
                <Maximize2 size={11} aria-hidden />
              </button>
            ) : null}
          </span>
        }
        hint={hint}
        inline={field.type === 'boolean'}
        spread={field.type === 'boolean'}
      >
        {control}
      </Field>
    );
  };

  // `visibleWhen` filters the RENDER only (ADR-0017 §7): the draft keeps every
  // value, so a field that is hidden at the moment still saves what it last held
  // — and the backend still validates it. Grouping inherits the same rule: an
  // all-hidden section renders no heading at all.
  const configGroups = groupVisibleFields(
    configTarget?.id === 'cursor'
      ? configSchema.filter((field) => !CURSOR_CLIENT_FACING_FIELDS.has(field.key))
      : configSchema,
    configSections,
    configDraft,
  );

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
          { key: 'actions', label: t('pluginPage.colActions'), align: 'center', width: 300 },
        ]}
        minWidth={760}
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
            <td style={CELL}>
              <div style={{ fontWeight: 'var(--font-semibold)' }}>{p.name}</div>
              {/* Error first (an operator scrolling the list needs the reason), then
                  the localized description clamped to two lines; the tooltip keeps
                  the full text plus where the plugin was loaded from. */}
              {p.error ? (
                <div style={{ ...DETAIL_CLAMP, color: 'var(--accent-red)' }} title={p.error}>
                  {p.error}
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
              {p.type === 'client-gateway' ? t('pluginPage.typeClientGateway') : t('pluginPage.typeModelService')}
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
              <span className={`badge ${p.disabled ? 'badge-warning' : p.loaded ? 'badge-success' : 'badge-danger'}`}>
                {p.disabled ? t('pluginPage.statusDisabled') : p.loaded ? t('pluginPage.statusLoaded') : t('pluginPage.statusError')}
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
          onClose={() => {
            // Closing the drawer must not leave the expand editor mounted on a
            // stale field (it renders above the drawer, so it would survive).
            setExpandTarget(null);
            setConfigTarget(null);
          }}
          closeLabel={t('common.close')}
          width="min(640px, 94vw)"
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
              {configTarget?.id === 'cursor' && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '12px' }}>
                  {t('pluginPage.cursorModelsMoved')}{' '}
                  <Link to="/clients">{t('pluginPage.cursorOpenClients')}</Link>
                </div>
              )}
              {configSchema.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('pluginPage.configEmpty')}</div>
              ) : (
                configGroups.map((group) => {
                  const key = group.id ?? '__top';
                  const heading = group.title !== undefined ? pickLocaleText(group.title, lang) : undefined;
                  // Advanced groups ship collapsed: they keep their values either
                  // way, so hiding them only shortens the scroll. The toggle is a
                  // real button (not a styled div) so it stays keyboard-reachable.
                  const collapsed = group.advanced && openAdvanced[key] !== true;
                  return (
                    <div key={key} className="form-section">
                      {heading ? <div className="form-section-title">{heading}</div> : null}
                      {collapsed ? (
                        <div>
                          <button type="button" className="btn btn-sm" onClick={() => setOpenAdvanced((prev) => ({ ...prev, [key]: true }))}>
                            <ChevronDown size={12} aria-hidden />
                            {t('pluginPage.configAdvancedShow')}
                          </button>
                        </div>
                      ) : (
                        <div style={CONFIG_LIST}>
                          {group.fields.map((field, index) => (
                            <div key={field.key} style={index === 0 ? undefined : CONFIG_DIVIDER}>
                              {renderConfigField(field)}
                            </div>
                          ))}
                          {group.advanced ? (
                            <div>
                              <button type="button" className="btn btn-sm" onClick={() => setOpenAdvanced((prev) => ({ ...prev, [key]: false }))}>
                                <ChevronUp size={12} aria-hidden />
                                {t('pluginPage.configAdvancedHide')}
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })
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
      {expandTarget ? (
        <Dialog
          title={pickLocaleText(expandTarget.title, lang) ?? humanizeKey(expandTarget.key)}
          // The field's own hint, not its key: the key stays a hover affordance
          // (see CONFIG_LABEL) so nothing re-introduces it at full weight, and
          // the hint is the useful context once the drawer behind is covered.
          subtitle={pickLocaleText(expandTarget.desc, lang)}
          onClose={() => setExpandTarget(null)}
          closeLabel={t('common.close')}
          maxSize={{ width: 'min(1040px, 92vw)', height: '84vh' }}
          footerRight={
            <button type="button" className="btn btn-primary" onClick={() => setExpandTarget(null)}>
              {t('common.close')}
            </button>
          }
        >
          {/* `flex: 1` + `minHeight: 0` fills the fixed-height card body (see
              Dialog's body comment); the drawer behind stays scroll-locked. */}
          <textarea
            className="input"
            value={String(configDraft[expandTarget.key] ?? '')}
            onChange={(e) => setConfigDraft((prev) => ({ ...prev, [expandTarget.key]: e.target.value }))}
            style={{
              flex: 1,
              minHeight: 0,
              width: '100%',
              resize: 'none',
              fontFamily: FONT_MONO,
              fontSize: 'var(--text-sm)',
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}
