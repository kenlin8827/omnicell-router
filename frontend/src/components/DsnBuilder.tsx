/**
 * DSN builder dialog for an MCP `dsn`-format parameter (ADR-0015 §D11).
 *
 * Edits a URL-style connection string (`scheme://[user[:pass]@]host[:port][/db]?k=v`) as structured
 * fields, with a raw-textarea fallback for anything `parseDsn` cannot split (an ODBC
 * `DSN=;UID=;PWD=` string, a `file:` path, …). Save writes the serialized string back to the
 * parameter table; the MCP package is never executed. The **Test connection** action is the only
 * network step: PostgreSQL and MySQL log in for real with the edited values (`select 1` / `ping`,
 * ADR-0015 §D11 amendment) and report WHICH part failed — authentication, database or TLS — while
 * every other scheme gets a credential-free TCP dial. The password is plain text here — ADR-0015
 * keeps secrets unmasked (the value is already visible in the launch line), and the compact table
 * cell shows a masked summary via `maskDsn`.
 *
 * SSL mode: a dedicated picker, because it is THE canonical postgres param. It is held OUT of the
 * params list on parse and re-injected on save; the dedicated value wins if an operator also types
 * a manual `sslmode` row (the live preview shows the result either way).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from './Dialog';
import { Field, FieldRow } from './Form';
import { Combobox, type ComboboxOption } from './Combobox';
import { useI18n } from '../i18n/I18nContext';
import { FONT_MONO } from '../lib/fonts';
import { api } from '../lib/api';
import {
  DSN_DRIVERS,
  DSN_SSLMODES,
  dsnEngineFor,
  dsnTarget,
  formatDsn,
  maskDsn,
  parseDsn,
  type DsnFields,
} from '../lib/dsn';

/** Monospace for the subtitle flag and the raw/preview strings — references the single font token. */
const MONO: React.CSSProperties = { fontFamily: FONT_MONO };

export interface DsnBuilderProps {
  /** The flag name shown in the subtitle (mono), e.g. `--dsn`. */
  name: string;
  /** The current DSN string; parsed into the builder fields on open. */
  value: string;
  onClose: () => void;
  onSave: (value: string) => void;
}

const blankFields = (): DsnFields => ({
  driver: '',
  user: '',
  password: '',
  host: '',
  port: '',
  database: '',
  params: [],
});

/** Driver picker options: the common set, plus the current driver first when it is not listed (so
 *  an unknown scheme parsed out of an existing value stays visible and selectable). */
const driverOptions = (driver: string): ComboboxOption[] => {
  const known = DSN_DRIVERS.map((d) => ({ value: d.value, label: d.label }));
  return driver !== '' && !known.some((o) => o.value === driver)
    ? [{ value: driver, label: driver }, ...known]
    : known;
};

/** Pull `sslmode` out of the params into the dedicated field; the builder keeps them apart. */
const splitSsl = (all: DsnFields): { fields: DsnFields; sslmode: string } => {
  const sslmode = all.params.find((p) => p.key === 'sslmode')?.value ?? '';
  return { fields: { ...all, params: all.params.filter((p) => p.key !== 'sslmode') }, sslmode };
};

export const DsnBuilder: React.FC<DsnBuilderProps> = ({ name, value, onClose, onSave }) => {
  const { t } = useI18n();

  const [parsed] = useState(() => parseDsn(value));
  const [fields, setFields] = useState<DsnFields>(() => (parsed ? splitSsl(parsed).fields : blankFields()));
  const [sslmode, setSslmode] = useState(() => (parsed ? splitSsl(parsed).sslmode : ''));
  const [raw, setRaw] = useState(value);
  const [rawMode, setRawMode] = useState(() => parsed === null);

  /** Connection-test state. The payload is derived from the editor, never from the rendered string,
   *  so a half-typed value cannot send something the operator did not see. */
  const [probe, setProbe] = useState<{
    phase: 'idle' | 'running' | 'done';
    code?: string;
    target?: string;
    message?: string;
  }>({ phase: 'idle' });
  /** Bumped on every payload change and every run, so a late answer never lands on a new value. */
  const probeSeq = useRef(0);

  /** What a client would dial: the builder fields, or the raw text while it is still URL-style. */
  const probeFields = rawMode ? parseDsn(raw) : fields;
  const probeTarget = probeFields ? dsnTarget(probeFields) : null;
  const probeParams: Record<string, string> = {};
  for (const param of probeFields?.params ?? []) probeParams[param.key] = param.value;
  // The dedicated picker owns `sslmode` while the structured form is open (same rule as the saved
  // string); the raw textarea carries whatever the operator typed.
  if (!rawMode && sslmode !== '') probeParams.sslmode = sslmode;
  const probePayload =
    probeTarget && probeFields
      ? {
          driver: probeFields.driver,
          host: probeTarget.host,
          port: probeTarget.port,
          user: probeFields.user,
          password: probeFields.password,
          database: probeFields.database,
          params: probeParams,
        }
      : null;
  const probeKey = probePayload ? JSON.stringify(probePayload) : '';

  useEffect(() => {
    probeSeq.current += 1;
    setProbe({ phase: 'idle' });
  }, [probeKey]);

  const runProbe = async () => {
    if (!probePayload) return;
    const seq = ++probeSeq.current;
    setProbe({ phase: 'running' });
    try {
      const result = await api.harnessMcpDsnProbe(probePayload);
      if (seq !== probeSeq.current) return;
      setProbe({ phase: 'done', code: result.code, target: result.target, message: result.message });
    } catch (error) {
      if (seq !== probeSeq.current) return;
      setProbe({
        phase: 'done',
        code: 'error',
        target: `${probePayload.host}:${probePayload.port}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const portValue = fields.port.trim();
  const portInvalid =
    portValue !== '' && (!/^\d+$/.test(portValue) || Number(portValue) < 1 || Number(portValue) > 65535);

  /** The verdict as one localized sentence; the driver's own text is appended where it explains
   *  which part failed (password, database, TLS). */
  const describeProbe = (): string => {
    const message = probe.message ?? '';
    switch (probe.code) {
      case 'ok':
        return t('harness.mcpDsnTestOk', { target: probe.target ?? '' });
      case 'reachable':
        return t('harness.mcpDsnTestReachable', { target: probe.target ?? '' });
      case 'auth_failed':
        return t('harness.mcpDsnTestAuthFailed', { message });
      case 'database_missing':
        return t('harness.mcpDsnTestDbMissing', { message });
      case 'tls_failed':
        return t('harness.mcpDsnTestTlsFailed', { message });
      case 'unsupported_auth':
        return t('harness.mcpDsnTestUnsupportedAuth', { message });
      case 'refused':
      case 'timeout':
      case 'unreachable':
        return t('harness.mcpDsnTestUnreachable', { target: probe.target ?? '', error: message });
      default:
        return t('harness.mcpDsnTestError', { message });
    }
  };

  /** The connection test, rendered in both editor modes because the raw textarea can still hold a
   *  URL-shaped value. PostgreSQL and MySQL log in for real; other schemes only get a TCP dial. */
  const renderProbe = () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 }}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!probePayload || probe.phase === 'running'}
        onClick={() => void runProbe()}
      >
        {probe.phase === 'running' ? t('harness.mcpDsnTestRunning') : t('harness.mcpDsnTest')}
      </button>
      {probe.phase === 'done' ? (
        <span
          style={{
            fontSize: 'var(--text-sm)',
            color:
              probe.code === 'ok' || probe.code === 'reachable'
                ? 'var(--accent-emerald)'
                : probe.code === 'unsupported_auth'
                  ? 'var(--accent-amber)'
                  : 'var(--accent-rose)',
          }}
        >
          {describeProbe()}
        </span>
      ) : probeTarget ? (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
          {/* The promise differs by engine: a real login for PostgreSQL/MySQL, a credential-free
              dial for everything else — the hint must say which one THIS driver gets. */}
          {dsnEngineFor(probeFields?.driver ?? '') !== null
            ? t('harness.mcpDsnTestHintDb', { target: `${probeTarget.host}:${probeTarget.port}` })
            : t('harness.mcpDsnTestHintTcp', { target: `${probeTarget.host}:${probeTarget.port}` })}
        </span>
      ) : (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('harness.mcpDsnTestNoTarget')}</span>
      )}
    </div>
  );

  const update = (patch: Partial<DsnFields>) => setFields((cur) => ({ ...cur, ...patch }));

  /** Merge the dedicated sslmode back in for formatting; the dedicated value wins over a manual row. */
  const mergedParams = (): { key: string; value: string }[] => {
    if (sslmode === '') return fields.params;
    return [...fields.params.filter((p) => p.key.trim() !== 'sslmode'), { key: 'sslmode', value: sslmode }];
  };

  const built = formatDsn({ ...fields, params: mergedParams() });

  /** The raw text is only switchable when it parses back into fields; raw mode exists for the
   *  strings that never will (ODBC `DSN=…`), so the switch button states that instead of no-oping. */
  const rawParsed = rawMode ? parseDsn(raw) !== null : false;

  const save = () => onSave(rawMode ? raw : built);

  const switchToBuilder = () => {
    const next = parseDsn(raw);
    if (!next) return; // not URL-style — stay in raw mode (the textarea is the right editor)
    const split = splitSsl(next);
    setFields(split.fields);
    setSslmode(split.sslmode);
    setRawMode(false);
  };

  const switchToRaw = () => {
    setRaw(built);
    setRawMode(true);
  };

  const updateParam = (index: number, patch: { key?: string; value?: string }) =>
    setFields((cur) => {
      const next = [...cur.params];
      next[index] = { ...next[index], ...patch };
      return { ...cur, params: next };
    });

  const removeParam = (index: number) =>
    setFields((cur) => ({ ...cur, params: cur.params.filter((_, i) => i !== index) }));

  const addParam = () => setFields((cur) => ({ ...cur, params: [...cur.params, { key: '', value: '' }] }));

  return (
    <Dialog
      title={t('harness.mcpDsnBuilderTitle')}
      subtitle={<span style={MONO}>{name}</span>}
      width={620}
      onClose={onClose}
      closeLabel={t('combobox.close')}
      footerRight={
        <>
          <button className="btn btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-sm" onClick={save}>
            {t('harness.mcpValueEditorSave')}
          </button>
        </>
      }
    >
      {rawMode ? (
        <>
          <textarea
            className="input"
            rows={6}
            autoFocus
            spellCheck={false}
            style={{ ...MONO, resize: 'vertical', lineHeight: 'var(--leading-snug)', minHeight: 120 }}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 8 }}>
            {/* The switch is only possible when the text parses back into fields; an ODBC-style
                `DSN=…` stays text-only, and the button must SAY so instead of failing silently. */}
            <div style={{ fontSize: 'var(--text-xs)', color: rawParsed ? 'var(--text-dim)' : 'var(--accent-amber)' }}>
              {rawParsed ? t('harness.mcpDsnRawHint') : t('harness.mcpDsnSwitchDisabled')}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!rawParsed}
              onClick={switchToBuilder}
            >
              {t('harness.mcpDsnSwitchBuilder')}
            </button>
          </div>
          {renderProbe()}
        </>
      ) : (
        <>
          <Field label={t('harness.mcpDsnDriver')}>
            <Combobox
              value={fields.driver}
              onChange={(v) => update({ driver: v })}
              options={driverOptions(fields.driver)}
              clearable
            />
          </Field>
          <FieldRow columns={3}>
            <Field label={t('harness.mcpDsnHost')}>
              <input
                className="input"
                style={{ width: '100%' }}
                autoComplete="off"
                value={fields.host}
                placeholder="localhost"
                onChange={(e) => update({ host: e.target.value })}
              />
            </Field>
            <Field
              label={t('harness.mcpDsnPort')}
              hint={
                portInvalid ? (
                  <span style={{ color: 'var(--accent-rose)' }}>{t('harness.mcpDsnPortInvalid')}</span>
                ) : undefined
              }
            >
              <input
                className="input"
                style={{ width: '100%' }}
                inputMode="numeric"
                autoComplete="off"
                value={fields.port}
                placeholder="5432"
                onChange={(e) => update({ port: e.target.value })}
              />
            </Field>
            <Field label={t('harness.mcpDsnDatabase')}>
              <input
                className="input"
                style={{ width: '100%' }}
                autoComplete="off"
                value={fields.database}
                placeholder="dbname"
                onChange={(e) => update({ database: e.target.value })}
              />
            </Field>
          </FieldRow>
          <FieldRow columns={2}>
            <Field label={t('harness.mcpDsnUser')}>
              <input
                className="input"
                style={{ width: '100%' }}
                autoComplete="off"
                value={fields.user}
                onChange={(e) => update({ user: e.target.value })}
              />
            </Field>
            <Field label={t('harness.mcpDsnPassword')}>
              <input
                className="input"
                style={{ width: '100%' }}
                autoComplete="off"
                value={fields.password}
                onChange={(e) => update({ password: e.target.value })}
              />
            </Field>
          </FieldRow>
          <Field label={t('harness.mcpDsnSslMode')}>
            <Combobox
              value={sslmode}
              onChange={setSslmode}
              options={DSN_SSLMODES.map((m) => ({ value: m, label: m }))}
              placeholder="—"
              clearable
            />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 6px' }}>
            <span className="form-label" style={{ margin: 0 }}>
              {t('harness.mcpDsnParams')}
            </span>
            <button type="button" className="btn btn-sm" onClick={addParam}>
              <Plus size={12} aria-hidden /> {t('harness.mcpDsnParamAdd')}
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {fields.params.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  className="input"
                  style={{ flex: '1 1 0', minWidth: 0 }}
                  autoComplete="off"
                  placeholder={t('harness.mcpDsnParamKey')}
                  value={row.key}
                  onChange={(e) => updateParam(i, { key: e.target.value })}
                />
                <input
                  className="input"
                  style={{ flex: '1 1 0', minWidth: 0 }}
                  autoComplete="off"
                  placeholder={t('harness.mcpDsnParamValue')}
                  value={row.value}
                  onChange={(e) => updateParam(i, { value: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ flex: '0 0 auto', padding: '4px 6px' }}
                  title={t('common.delete')}
                  onClick={() => removeParam(i)}
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <span className="form-label">{t('harness.mcpDsnPreview')}</span>
            <div
              style={{
                ...MONO,
                fontSize: 'var(--text-sm)',
                color: 'var(--text-dim)',
                overflowWrap: 'anywhere',
                marginTop: 4,
              }}
            >
              {maskDsn(built) || '—'}
            </div>
          </div>
          {renderProbe()}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="btn btn-sm" onClick={switchToRaw}>
              {t('harness.mcpDsnSwitchRaw')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
};
