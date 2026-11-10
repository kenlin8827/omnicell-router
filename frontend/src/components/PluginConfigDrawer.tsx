import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Maximize2, Settings2 } from 'lucide-react';
import { Combobox } from './Combobox';
import { Dialog } from './Dialog';
import { Drawer } from './Drawer';
import { Field } from './Form';
import { SegGroup } from './SegGroup';
import { Switch } from './Switch';
import { api, opencodeApi, type ApiKeyItem, type PluginConfigFieldInfo, type PluginConfigSectionInfo, type PluginViewInfo } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { groupVisibleFields, pickLocaleText } from '../lib/plugin-config';
import { sortModelOptions } from '../lib/model-options';
import { useToast } from './ToastProvider';
import { FONT_MONO } from '../lib/fonts';
import { humanizeKey } from '../lib/format';

/**
 * Schema-driven settings drawer for one plugin (the operator-facing config: the
 * backend reports the plugin's flat schema plus its current values with defaults
 * merged, this drawer renders one control per field and PUTs the full values
 * object back). Shared by the Plugins page and the Cursor client card so the
 * editor exists exactly once — the client card opens it in place instead of
 * navigating away and discarding its own draft.
 */

/** A gateway's model surface is a CLIENT concern and is edited in Client Hub.
 *  These keys stay in the schema (the storage contract) but are not rendered a
 *  second time here — one source, one editor. */
const GATEWAY_CLIENT_FACING_FIELDS: Record<string, true> = {
  model: true,
  forceModel: true,
  modelListMode: true,
  models: true,
  accountKeyId: true,
  catalogReplace: true,
};

/** Plugins whose model surface is edited on a Client Hub card. */
const GATEWAY_PLUGIN_CLIENT: Record<string, string> = {
  'cursor-gateway': 'Cursor',
  'qoder-gateway': 'Qoder',
};
const isClientGateway = (id: string): boolean => GATEWAY_PLUGIN_CLIENT[id] !== undefined;

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

export interface PluginConfigDrawerProps {
  /** Target plugin. The drawer is mounted only while one is selected, so it
   *  never renders another plugin's schema. */
  plugin: PluginViewInfo;
  onClose: () => void;
  /** Show the "model selection lives in Client Hub" pointer. Off when the
   *  drawer is opened FROM that page — telling the reader to go where they
   *  already are is noise. */
  showClientsGuide?: boolean;
}

export const PluginConfigDrawer: React.FC<PluginConfigDrawerProps> = ({ plugin, onClose, showClientsGuide = true }) => {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [schema, setSchema] = useState<PluginConfigFieldInfo[]>([]);
  const [sections, setSections] = useState<PluginConfigSectionInfo[]>([]);
  /** Declared `advanced` sections the operator has opened (id set). Collapsed
   *  is the default: advanced settings keep their values either way. */
  const [openAdvanced, setOpenAdvanced] = useState<Record<string, boolean>>({});
  /** Textarea field opened in the large editor (null = closed). The editor edits
   *  the SAME draft entry, so there is nothing to "apply" on close. */
  const [expandTarget, setExpandTarget] = useState<PluginConfigFieldInfo | null>(null);
  const [draft, setDraft] = useState<ConfigDraft>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
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

  // Load the schema/values whenever the target changes. A 404 (disabled/unloaded
  // plugin) surfaces inline in the drawer body.
  useEffect(() => {
    let cancelled = false;
    setSchema([]);
    setSections([]);
    setOpenAdvanced({});
    setExpandTarget(null);
    setDraft({});
    setError(null);
    setWarnings([]);
    setSaved(false);
    setLoading(true);
    opencodeApi
      .getPluginConfig(plugin.id)
      .then((res) => {
        if (cancelled) return;
        const nextSchema = res.schema ?? [];
        setSchema(nextSchema);
        setSections(res.sections ?? []);
        setDraft(buildDraft(nextSchema, res.values ?? {}));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setWarnings([]);
    setSaved(false);
    try {
      let next = draft;
      // Follow mode is a SNAPSHOT, exactly like the clients page: the plugin
      // never receives the key secret and core exposes no key-policy lookup to
      // plugins, so the console resolves the key's allowed models here and
      // stores the resulting ids. Re-save after changing the key's policy.
      if (isClientGateway(plugin.id) && next.modelListMode === 'follow') {
        const keyId = String(next.accountKeyId ?? '');
        if (!keyId) {
          toast.error(t('clients.followNoKey'));
          return;
        }
        const view = await api.getKeyModels(keyId);
        next = {
          ...next,
          models: view.models.filter((model) => model.allowed).map((model) => model.id).join('\n'),
        };
      }
      const res = await opencodeApi.putPluginConfig(plugin.id, buildValues(schema, next));
      setDraft(buildDraft(schema, res.values ?? {}));
      setWarnings(res.warnings ?? []);
      setSaved(true);
      toast.success(t('pluginPage.configSaved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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
    const raw = draft[field.key];
    const setField = (value: string | boolean): void => setDraft((prev) => ({ ...prev, [field.key]: value }));

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
    isClientGateway(plugin.id) ? schema.filter((field) => GATEWAY_CLIENT_FACING_FIELDS[field.key] !== true) : schema,
    sections,
    draft
  );

  return (
    <>
      <Drawer
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings2 size={17} aria-hidden />
            <span>{t('pluginPage.configTitle')}</span>
          </span>
        }
        subtitle={`${plugin.name} · ${plugin.version}`}
        onClose={() => {
          // Closing the drawer must not leave the expand editor mounted on a
          // stale field (it renders above the drawer, so it would survive).
          setExpandTarget(null);
          onClose();
        }}
        closeLabel={t('common.close')}
        width="min(640px, 94vw)"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void save()}
              disabled={saving || loading || error !== null}
            >
              {t('pluginPage.configSave')}
            </button>
          </>
        }
      >
        {loading ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('common.loading')}</div>
        ) : error !== null ? (
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)' }}>
            {t('pluginPage.configInvalid')}: {error}
          </div>
        ) : (
          <>
            {showClientsGuide && isClientGateway(plugin.id) && (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '12px' }}>
                {t('pluginPage.gatewayModelsMoved', { client: GATEWAY_PLUGIN_CLIENT[plugin.id] })}{' '}
                <Link to="/clients">{t('pluginPage.cursorOpenClients')}</Link>
              </div>
            )}
            {schema.length === 0 ? (
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
            {warnings.length > 0 ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-amber)' }}>
                <div style={{ fontWeight: 'var(--font-semibold)' }}>{t('pluginPage.configWarnings')}</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {saved && warnings.length === 0 ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-emerald)' }}>{t('pluginPage.configSaved')}</div>
            ) : null}
          </>
        )}
      </Drawer>
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
            value={String(draft[expandTarget.key] ?? '')}
            onChange={(e) => setDraft((prev) => ({ ...prev, [expandTarget.key]: e.target.value }))}
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
};
