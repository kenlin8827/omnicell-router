/**
 * Model-side policy for names the gateway cannot resolve:
 * `forwardProxy.unresolvedModel` (ADR-0003 §7a).
 *
 * It lives here, next to the model vocabulary it actually speaks — the action
 * values are `fail`, `direct`, and any gateway-visible modelRef (including
 * `auto` and combo ids), which is model ADDRESSING, not transport. The inbound
 * proxy page owns bytes (listen socket, rule table, access log) and used to
 * fetch the whole gateway model catalogue only to fill this one picker.
 *
 * Two facts that stay true wherever the UI puts it: the policy is consulted on
 * the MITM leg only (a client dialing /v1 directly keeps its historical 404),
 * and the per-host overrides key off the Host the client dialed.
 *
 * Save is merge-on-write: this page owns exactly one key inside
 * `forwardProxy`, and the inbound page saves that whole section, so both sides
 * re-read the document before writing.
 */
import React, { useEffect, useState } from 'react';
import { Save, ShieldQuestion, Trash2 } from 'lucide-react';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { sortModelOptions } from '../lib/model-options';
import { modelRefBadge } from '../lib/modelRefBadge';

interface GatewayModelOption {
  id: string;
  kind?: string;
  members?: number;
  wire?: string;
}

interface HostRow {
  host: string;
  onMiss: string;
}

/** Only the fields this page owns enter the dirty check, and hosts are keyed
 *  the way the backend normalizer persists them (trimmed, lowercased) — so an
 *  untouched row never reads as a change, and a case-only edit does not either. */
function keyOf(action: string, rows: HostRow[]): string {
  return JSON.stringify({
    onMiss: action,
    hosts: rows
      .filter(r => r.host.trim() && r.onMiss.trim())
      .map(r => [r.host.trim().toLowerCase(), r.onMiss.trim()]),
  });
}

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  marginBottom: '4px',
  display: 'block',
};

export const ModelFallbackPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();

  const [onMiss, setOnMiss] = useState('auto');
  const [rows, setRows] = useState<HostRow[]>([]);
  const [models, setModels] = useState<GatewayModelOption[]>([]);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);


  useEffect(() => {
    api.getConfig().then(cfg => {
      const um = ((cfg.forwardProxy as Record<string, unknown> | undefined)?.unresolvedModel || {}) as {
        onMiss?: string;
        hosts?: Record<string, string>;
      };
      const nextOnMiss = um.onMiss || 'auto';
      const nextRows = Object.entries(um.hosts || {}).map(([host, action]) => ({ host, onMiss: action }));
      setOnMiss(nextOnMiss);
      setRows(nextRows);
      setSavedKey(keyOf(nextOnMiss, nextRows));
      setLoading(false);
    }).catch(() => setLoading(false));
    // The picker pool is the model catalogue: the two verbs first, then every
    // addressable modelRef. Decision-wire models are dropped — no chat surface
    // can address them, so a fallback to one would always fail.
    api.listGatewayModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  const dirty = savedKey !== null && savedKey !== keyOf(onMiss, rows);

  const options = (current: string): ComboboxOption[] => {
    const refs = sortModelOptions(
      models
        .filter(m => m.wire !== 'systemone')
        .map(m => ({
          kind: m.kind,
          value: m.id,
          label: m.id,
          meta: m.kind === 'combo' && m.members !== undefined ? t('models.memberCount', { n: m.members }) : undefined,
          ...modelRefBadge(m.kind, t),
        }))
    );
    const all: ComboboxOption[] = [
      { value: 'fail', label: t('modelFallback.modeFail') },
      { value: 'direct', label: t('modelFallback.modeDirect') },
      ...refs,
    ];
    // A value saved outside the current catalogue is echoed first so the
    // trigger never renders empty.
    return current && !all.some(o => o.value === current) ? [{ value: current, label: current }, ...all] : all;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Re-read before writing: the inbound page saves the whole forwardProxy
      // section, so only this one key may be ours.
      const fresh = await api.getConfig();
      const fp = (fresh.forwardProxy || {}) as Record<string, unknown>;
      const hosts = Object.fromEntries(
        rows
          .filter(r => r.host.trim() && r.onMiss.trim())
          .map(r => [r.host.trim().toLowerCase(), r.onMiss.trim()])
      );
      await api.saveConfig({ forwardProxy: { ...fp, unresolvedModel: { onMiss: onMiss || 'auto', hosts } } });
      setSavedKey(keyOf(onMiss, rows));
      toast.success(t('modelFallback.savedNotice'));
    } catch (err: unknown) {
      toast.error(`${t('common.saveFailed')}${(err as { message?: string })?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="card" style={{ flex: 1, minHeight: 0 }}>
        <div className="card-header">
          <div className="card-title">
            <ShieldQuestion size={18} color="var(--accent)" />
            <span>{t('modelFallback.title')}</span>
          </div>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '16px', whiteSpace: 'pre-line' }}>
          {t('modelFallback.hint')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' }}>
          <div>
            <label style={fieldLabel}>{t('modelFallback.onMiss')}</label>
            <Combobox value={onMiss} onChange={setOnMiss} options={options(onMiss)} />
          </div>

          <div>
            <label style={fieldLabel}>{t('modelFallback.hosts')}</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {rows.map((row, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder={t('modelFallback.hostPlaceholder')}
                    value={row.host}
                    onChange={e => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], host: e.target.value };
                      setRows(next);
                    }}
                    className="input"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Combobox
                    value={row.onMiss}
                    onChange={v => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], onMiss: v };
                      setRows(next);
                    }}
                    options={options(row.onMiss)}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    className="btn btn-danger btn-sm"
                    style={{ padding: '4px 8px' }}
                    onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                className="btn btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setRows([...rows, { host: '', onMiss: 'auto' }])}
              >
                {t('modelFallback.addHost')}
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
              marginTop: '4px',
              paddingTop: '14px',
              borderTop: '1px solid var(--divider)',
            }}
          >
            <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving || !dirty}>
              <Save size={14} />
              <span>{t('common.save')}</span>
            </button>
            {dirty && <span className="badge badge-warning">{t('modelFallback.unsaved')}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
