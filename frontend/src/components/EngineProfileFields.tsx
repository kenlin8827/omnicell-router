/**
 * Engine launch-profile fields, rendered INSIDE the run page's launch-parameter
 * drawer (`localModels.runAdvanced`). ONE launch form; the selected engine
 * decides which rows appear (ADR-0039).
 *
 *   llama.cpp → CPU threads + extra arguments (no profile at all)
 *   Strata    → pack / native / PLE / expert-profile / MTP / spec / vision …
 *   <future>  → whatever its descriptor declares; this file needs no edit.
 *
 * The schema (labels, kinds, groups, required flags) comes from the backend's
 * engine catalog — the engine's own `EngineProfileSpec` — so a new engine ships
 * its form as data. Dotted keys (`vision.exe`) address nested profile objects.
 *
 * Deliberately NOT repeated here, because the run options already own them:
 *   ctx        → the page's context ladder (a run option overrides the profile)
 *   kv         → the acceleration panel's KV switch (`localModels.runKvQ8`)
 *   extra args → the drawer's own extra-arguments field (`localModels.runExtraArgs`)
 *   host       → not operator input at all: the engine always binds loopback
 *                (ADR-0038 §4), the gateway is the only outward face
 *   port       → gateway-allocated per launch, never operator input
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Field, FormSection, FieldRow } from './Form';
import { Combobox } from './Combobox';
import { api, type LocalEngineProfileGroup, type LocalInstalledModel } from '../lib/api';
import { engineProfileOf } from '../lib/local-profile';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from './ToastProvider';

/** Sentinel option value of a `customizable` select: swaps the dropdown for
 *  the typed input. Never stored — the text input owns the value. */
const CUSTOM_VALUE = '__custom__';

interface Props {
  model: LocalInstalledModel;
  engine: string;
  engineName: string;
  /** i18n key of the intro paragraph. */
  intro: string;
  groups: LocalEngineProfileGroup[];
  onSaved: (model: LocalInstalledModel) => void;
}

type FormState = Record<string, string>;

/** Read one dotted path out of the stored profile. */
function getPath(source: unknown, key: string): unknown {
  let cursor: unknown = source;
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Write one dotted path, creating intermediate objects. */
function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function deletePath(target: Record<string, unknown>, key: string): void {
  const parts = key.split('.');
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[parts[parts.length - 1]];
  // An object left empty by the deletion is noise in the stored record.
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    let parent: Record<string, unknown> = target;
    for (const part of parts.slice(0, depth - 1)) {
      const next = parent[part];
      if (!next || typeof next !== 'object') return;
      parent = next as Record<string, unknown>;
    }
    const container = parent[parts[depth - 1]];
    if (container && typeof container === 'object' && Object.keys(container as object).length === 0) {
      delete parent[parts[depth - 1]];
    } else {
      return;
    }
  }
}

/** Form text for one stored value, whatever its wire shape is. */
function toFormText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.join(' ');
  return String(value);
}

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' };

export const EngineProfileFields: React.FC<Props> = ({ model, engine, engineName, intro, groups, onSaved }) => {
  const { t } = useI18n();
  const toast = useToast();
  const existing = useMemo(() => engineProfileOf(model, engine) ?? {}, [model, engine]);
  const [form, setForm] = useState<FormState>({});
  const [saving, setSaving] = useState(false);
  /** A `customizable` select currently showing its typed input, per field key. */
  const [customMode, setCustomMode] = useState<Record<string, boolean>>({});

  // Re-seed whenever the record or the engine changes (switch model/engine, or
  // a save round-trips).
  useEffect(() => {
    const next: FormState = {};
    const custom: Record<string, boolean> = {};
    for (const group of groups) {
      for (const field of group.fields) {
        next[field.key] = toFormText(getPath(existing, field.key));
        // A stored value the dropdown does not know IS a custom path — open
        // the typed input directly, or the pick would misread it as unset.
        if (field.kind === 'select' && field.customizable) {
          const value = next[field.key];
          custom[field.key] = !!value && !(field.options ?? []).some((option) => option.value === value);
        }
      }
    }
    setForm(next);
    setCustomMode(custom);
  }, [existing, groups]);

  const configured = Object.keys(existing).length > 0;
  const missingRequired = groups
    .flatMap((group) => group.fields)
    .filter((field) => field.required && !(form[field.key] ?? '').trim());

  /** Form strings → the wire shape. Fields the form does not render (a legacy
   *  or hand-written key) survive untouched, so a re-save never loses data. */
  const toProfile = (): Record<string, unknown> => {
    const out = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;
    for (const group of groups) {
      for (const field of group.fields) {
        const raw = (form[field.key] ?? '').trim();
        if (!raw) {
          deletePath(out, field.key);
          continue;
        }
        if (field.kind === 'number') {
          const value = Number(raw);
          if (Number.isFinite(value)) setPath(out, field.key, value);
          continue;
        }
        if (field.kind === 'boolean') {
          setPath(out, field.key, raw === 'true');
          continue;
        }
        if (field.kind === 'list') {
          const items = raw.split(/\s+/).filter(Boolean);
          if (items.length > 0) setPath(out, field.key, items);
          continue;
        }
        setPath(out, field.key, raw);
      }
    }
    return out;
  };

  const save = async () => {
    if (saving || missingRequired.length > 0) return;
    setSaving(true);
    try {
      const result = await api.setLocalEngineProfile(model.id, engine, toProfile());
      if (result.status !== 'ok' || !result.model) {
        toast.error(result.message || t('localModels.engineProfileSaveFailed', { engine: engineName }));
        return;
      }
      toast.success(t('localModels.engineProfileSaved', { engine: engineName }));
      onSaved(result.model);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving || !configured) return;
    setSaving(true);
    try {
      const result = await api.clearLocalEngineProfile(model.id, engine);
      if (result.status !== 'ok' || !result.model) {
        toast.error(result.message || t('localModels.engineProfileSaveFailed', { engine: engineName }));
        return;
      }
      toast.success(t('localModels.engineProfileCleared', { engine: engineName }));
      onSaved(result.model);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', lineHeight: 1.6 }}>{t(intro)}</p>

      {groups.map((group) => {
        const rows: typeof group.fields[] = [];
        for (let i = 0; i < group.fields.length; i += 2) rows.push(group.fields.slice(i, i + 2));
        return (
          <FormSection key={group.id} title={t(group.label)}>
            {rows.map((row, index) => (
              <FieldRow key={`${group.id}-${index}`} columns={row.length}>
                {row.map((field) => (
                  <Field key={field.key} label={t(field.label)} {...(field.hint ? { hint: t(field.hint) } : {})}>
                    {field.kind === 'select' ? (
                      field.customizable && customMode[field.key] ? (
                        /* The typed override (a path discovery cannot see). The
                           sentinel never reaches the form value — this input
                           owns it, and "presets" swaps back to the dropdown. */
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            className="input"
                            value={form[field.key] ?? ''}
                            placeholder={field.placeholder}
                            spellCheck={false}
                            onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                            style={{ ...mono, flex: 1, minWidth: 0 }}
                          />
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ flexShrink: 0 }}
                            onClick={() => setCustomMode((prev) => ({ ...prev, [field.key]: false }))}
                          >
                            {t('localModels.engineFieldPresets')}
                          </button>
                        </div>
                      ) : (
                        <Combobox
                          options={[
                            { value: '', label: field.placeholder ?? '—' },
                            ...(field.options ?? []).map((option) => ({
                              value: option.value,
                              label: option.labelKey ? t(option.labelKey) : option.label,
                            })),
                            ...(field.customizable ? [{ value: CUSTOM_VALUE, label: t('localModels.engineFieldCustom') }] : []),
                          ]}
                          value={form[field.key] ?? ''}
                          onChange={(v) => {
                            if (v === CUSTOM_VALUE) {
                              setCustomMode((prev) => ({ ...prev, [field.key]: true }));
                              return;
                            }
                            setForm((prev) => ({ ...prev, [field.key]: v }));
                          }}
                        />
                      )
                    ) : field.kind === 'boolean' ? (
                      <Combobox
                        options={[
                          { value: '', label: t('localModels.engineFieldUnset') },
                          { value: 'true', label: t('localModels.engineFieldOn') },
                          { value: 'false', label: t('localModels.engineFieldOff') },
                        ]}
                        value={form[field.key] ?? ''}
                        onChange={(v) => setForm((prev) => ({ ...prev, [field.key]: v }))}
                      />
                    ) : field.kind === 'list' ? (
                      <input
                        className="input"
                        value={form[field.key] ?? ''}
                        placeholder={field.placeholder}
                        spellCheck={false}
                        onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        style={mono}
                      />
                    ) : (
                      <input
                        className="input"
                        type={field.kind === 'number' ? 'number' : 'text'}
                        value={form[field.key] ?? ''}
                        placeholder={field.placeholder}
                        spellCheck={false}
                        {...(field.kind === 'number'
                          ? {
                              ...(field.min !== undefined ? { min: field.min } : {}),
                              ...(field.max !== undefined ? { max: field.max } : {}),
                              ...(field.step !== undefined ? { step: field.step } : {}),
                            }
                          : {})}
                        onChange={(e) => setForm((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        {...(field.mono ? { style: mono } : {})}
                      />
                    )}
                  </Field>
                ))}
              </FieldRow>
            ))}
          </FormSection>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {configured && (
          <button className="btn btn-sm" type="button" onClick={() => void clear()} disabled={saving}>
            {t('localModels.engineProfileClear')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-sm btn-primary"
          type="button"
          onClick={() => void save()}
          disabled={saving || missingRequired.length > 0}
        >
          {saving && <Loader2 size={12} style={{ animation: 'ocr-spin 0.8s linear infinite' }} />}
          {t('localModels.engineProfileSave')}
        </button>
      </div>
    </div>
  );
};
