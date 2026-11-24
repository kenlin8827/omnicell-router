import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Info, ListFilter, Save, ShieldAlert } from 'lucide-react';
import { api, opencodeApi } from '../lib/api';
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
  const [providerIds, setProviderIds] = useState<string[]>([]);
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
    // Quick-add options come from the providers this machine actually has a key
    // for — never a hardcoded vendor list. A failed fetch just means no
    // quick-add; the lists stay fully editable by hand.
    opencodeApi.listModels({ connected: true }).then(res => {
      const ids = [...new Set(res.models.map(m => m.providerId).filter(Boolean))].sort();
      setProviderIds(ids);
    }).catch(() => {});
  }, []);

  /** Provider-level patterns for the quick-add dialog, minus whatever the list
   *  already holds (the dialog never duplicates a row the operator typed). */
  const suggestionsFor = (picked: string[]) =>
    providerIds.map(p => `${p}/*`).filter(s => !picked.includes(s));

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

  /** Nothing is proxied until a model is named: an empty allowlist is direct. */
  const idle = includes.length === 0;

  /** One status block covers all three states: master switch off > no rule > routing. */
  const status: 'off' | 'idle' | 'active' = !endpoint?.enabled ? 'off' : idle ? 'idle' : 'active';
  const statusTone = status === 'active' ? 'var(--accent-emerald)' : status === 'idle' ? 'var(--text-dim)' : 'var(--accent-amber)';

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
          {/* Effective state, above the fields it describes: a badge squeezed
              into the endpoint row reads as a property OF the URL, while it is
              the conclusion of the include list below. Its own quiet line keeps
              the endpoint row to [endpoint] [manage] and mirrors the
              forward-proxy page's banner convention. */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm, 6px)',
              border: '1px solid var(--divider)',
              background: 'var(--bg-inset, transparent)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-normal)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <Info size={14} style={{ flexShrink: 0, marginTop: '2px', color: statusTone }} aria-hidden="true" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <strong style={{ color: 'var(--text-main)', fontWeight: 'var(--font-semibold)' }}>
                  {status === 'idle'
                    ? t('proxyPatterns.noInclude')
                    : status === 'active'
                      ? t('proxyPatterns.active', { n: includes.length })
                      : t('proxyPatterns.disabled')}
                </strong>
                <span style={{ color: 'var(--text-dim)' }}>
                  {status === 'off'
                    ? t('proxyPatterns.disabledHint')
                    : status === 'active'
                      ? t('proxyPatterns.activeHint')
                      : t('proxyPatterns.idleHint')}
                </span>
              </div>
            </div>
            {/* Scope boundary, stated where the mistake is made (ADR-0018 vs
                ADR-0022): operators configure `forwardProxy.rules` expecting it
                to govern upstream calls, and read an empty Include list as "no
                exclusions". Both leave every probe and every completion direct,
                which then looks like the split silently failing. */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', paddingTop: '6px', borderTop: '1px solid var(--divider)' }}>
              <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--text-dim)' }} aria-hidden="true" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, color: 'var(--text-dim)', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-normal)' }}>
                <span>{t('proxyPatterns.scopeHint')}</span>
                <span>{t('proxyPatterns.excludesHint')}</span>
              </div>
            </div>
          </div>
          {/* Which proxy these patterns route through — read-only on purpose.
              The endpoint is capability config and is edited on the Outbound
              Proxy page (Proxy Management group), never here. */}
          <div>
            <label style={fieldLabel}>{t('proxyPatterns.endpoint')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
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
            suggestions={suggestionsFor(includes)}
          />
          <PatternListEditor
            label={t('proxy.excludes')}
            placeholder={t('proxy.pattern')}
            addLabel={t('proxy.addPattern')}
            patterns={excludes}
            onChange={setExcludes}
            suggestions={suggestionsFor(excludes)}
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
