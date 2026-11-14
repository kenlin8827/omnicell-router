import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, ListFilter, Save } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { InfoTip } from '../components/InfoTip';
import { PatternListEditor } from '../components/PatternListEditor';

/**
 * The MODEL-side half of the outbound proxy config: `proxy.includes` /
 * `proxy.excludes` — the globs that decide which providers/models route through
 * the outbound proxy. The capability itself (enable switch, manual URL / mihomo
 * endpoint, core management) lives on the Outbound Proxy page under the Proxy
 * Management group; this page is the reference side that sits next to the
 * model vocabulary it matches (ADR-0022 include/exclude semantics).
 */

type ProxyMode = 'manual' | 'mihomo';

/** Read-only view of the endpoint this page's patterns route through. */
interface EndpointSnapshot {
  enabled: boolean;
  mode: ProxyMode;
  url?: string;
  mixedPort?: number;
}

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  marginBottom: '4px',
  display: 'block',
};

export const ProxyPatternsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();

  const [endpoint, setEndpoint] = useState<EndpointSnapshot | null>(null);
  const [includes, setIncludes] = useState<string[]>([]);
  const [excludes, setExcludes] = useState<string[]>([]);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getConfig().then(cfg => {
      const section = (cfg.proxy || {}) as { enabled?: boolean; mode?: ProxyMode; url?: string; includes?: string[]; excludes?: string[]; mihomo?: { mixedPort?: number } };
      setEndpoint({
        enabled: section.enabled === true,
        mode: section.mode === 'mihomo' ? 'mihomo' : 'manual',
        url: section.url,
        mixedPort: section.mihomo?.mixedPort,
      });
      setIncludes(section.includes || []);
      setExcludes(section.excludes || []);
      setSavedKey(JSON.stringify({ includes: section.includes || [], excludes: section.excludes || [] }));
      setLoading(false);
    }).catch(console.error);
  }, []);

  const dirty = savedKey !== null && savedKey !== JSON.stringify({ includes, excludes });

  const handleSave = async () => {
    setSaving(true);
    try {
      // Re-read the config right before the write: a save here must never
      // clobber endpoint edits that landed on the Outbound Proxy page since
      // this page loaded — only the two pattern fields are ours.
      const fresh = await api.getConfig();
      const next = { ...((fresh.proxy || {}) as Record<string, unknown>), includes, excludes };
      await api.saveConfig({ proxy: next });
      setSavedKey(JSON.stringify({ includes, excludes }));
      toast.success(t('proxy.savedNotice'));
    } catch (err: unknown) {
      toast.error(`${t('common.failed')}: ${(err as { message?: string })?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }

  /** The endpoint the patterns route THROUGH, for display only: manual URL, or
   *  the mihomo mixed port. An empty manual URL means direct. */
  const endpointUrl = endpoint?.mode === 'mihomo'
    ? `http://127.0.0.1:${endpoint.mixedPort ?? 7890}`
    : (endpoint?.url || '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="card" style={{ flex: 1, minHeight: 0 }}>
        <div className="card-header">
          <div className="card-title">
            <ListFilter size={18} color="var(--accent)" />
            <span>{t('proxyPatterns.title')}</span>
          </div>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '16px', whiteSpace: 'pre-wrap' }}>
          {t('proxyPatterns.hint')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' }}>
          {/* Which proxy these patterns route through — read-only on purpose.
              The endpoint is capability config and is edited on the Outbound
              Proxy page (Proxy Management group), never here. */}
          <div>
            <label style={fieldLabel}>{t('proxyPatterns.endpoint')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              {endpoint && !endpoint.enabled && <span className="badge badge-amber">{t('proxyPatterns.disabled')}</span>}
              <code style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 'var(--text-xs)',
                padding: '3px 8px',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--divider)',
                background: 'var(--bg-inset, transparent)',
                color: 'var(--text-dim)',
              }}>
                {endpointUrl || '—'}
              </code>
              <InfoTip text={t('proxyPatterns.endpointHint')} />
              <Link to="/proxy-upstream" className="btn btn-sm">
                <ArrowLeftRight size={13} />
                <span>{t('proxyPatterns.endpointManage')}</span>
              </Link>
            </div>
          </div>
          <PatternListEditor
            label={t('proxy.includes')}
            placeholder={t('proxy.pattern')}
            addLabel={t('proxy.addPattern')}
            patterns={includes}
            onChange={setIncludes}
          />
          <PatternListEditor
            label={t('proxy.excludes')}
            placeholder={t('proxy.pattern')}
            addLabel={t('proxy.addPattern')}
            patterns={excludes}
            onChange={setExcludes}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
            marginTop: '4px',
            paddingTop: '14px',
            borderTop: '1px solid var(--divider)',
          }}>
            <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving || !dirty}>
              <Save size={14} />
              <span>{t('proxy.saveBtn')}</span>
            </button>
            {dirty && <span className="badge badge-warning">{t('proxy.unsaved')}</span>}
            <InfoTip text={t('proxyPatterns.saveHint')} />
          </div>
        </div>
      </div>
    </div>
  );
};
