/**
 * Outbound proxy — the endpoint-selection half of the capability.
 *
 * Three fields, one card: master switch, mode (manual URL vs the built-in
 * Clash core), and the forward URL. Everything the core itself owns
 * (binary lifecycle, subscriptions, nodes, rules, connectivity checks) lives on
 * MihomoPage; the model-scoped include/exclude globs live on ProxyPatternsPage.
 * Those two are pointed at by a single quiet index line at the foot of the card
 * — destinations, not steps, so they do not get button-weight chrome.
 * This page is deliberately the smallest of the three — it answers "is outbound
 * traffic proxied, and through what", nothing else.
 *
 * All three pages write the same `proxy:` section of the config file, so a save
 * re-reads the document and merges only the fields owned here.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, ArrowRight, Save } from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import { Switch } from '../components/Switch';
import { SegGroup } from '../components/SegGroup';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';

type ProxyMode = 'manual' | 'mihomo';

/** Loose on purpose: the rest of the section (mihomo block, patterns) belongs to
 *  sibling pages and must survive a save here byte-for-byte. */
interface ProxyShape {
  enabled?: boolean;
  mode?: ProxyMode;
  url?: string;
  includes?: string[];
  excludes?: string[];
  mihomo?: Record<string, unknown>;
}

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  marginBottom: '4px',
  display: 'block',
};

export const ProxyPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [proxy, setProxy] = useState<ProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  // Only the fields this page owns enter the dirty check: a node selection saved
  // on the Mihomo page must not light up "unsaved changes" here.
  const keyOf = (p: ProxyShape) =>
    JSON.stringify({ enabled: p.enabled ?? false, mode: p.mode ?? 'manual', url: p.url ?? '' });
  const draftKey = proxy ? keyOf(proxy) : null;
  const dirty = savedKey !== null && draftKey !== null && savedKey !== draftKey;

  useEffect(() => {
    api.getConfig().then(cfg => {
      const next = (cfg.proxy || {}) as ProxyShape;
      if (!next.mode) next.mode = 'manual';
      setProxy(next);
      setSavedKey(keyOf(next));
      setLoading(false);
    }).catch(console.error);
  }, []);

  const patch = (partial: Partial<ProxyShape>) => setProxy(prev => ({ ...(prev || {}), ...partial }));

  const handleSave = async () => {
    if (!proxy) return;
    setSaving(true);
    try {
      // Merge-on-write: re-read so a mihomo block or a pattern list edited on a
      // sibling page since this page loaded is not rolled back to a stale copy.
      const cfg = await api.getConfig();
      const latest = (cfg.proxy || {}) as ProxyShape;
      const next: ProxyShape = {
        ...latest,
        enabled: proxy.enabled ?? false,
        mode: proxy.mode ?? 'manual',
        url: proxy.url ?? '',
      };
      await api.saveConfig({ proxy: next });
      setProxy(next);
      setSavedKey(keyOf(next));
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      toast.error(err?.message ? String(err.message) : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !proxy) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }

  const mode: ProxyMode = proxy.mode === 'mihomo' ? 'mihomo' : 'manual';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0 }}>
      <div className="card" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div className="card-header">
          <div className="card-title">
            <ArrowLeftRight size={18} color="var(--accent)" />
            <span>{t('proxy.title')}</span>
          </div>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginBottom: '16px', whiteSpace: 'pre-wrap' }}>
          {t('proxy.hint')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' }}>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-md)', cursor: 'pointer' }}>
            <span>{t('proxy.enable')}</span>
            <Switch checked={proxy.enabled ?? false} onChange={v => patch({ enabled: v })} />
          </label>
          <div>
            <label style={fieldLabel}>{t('proxy.mode')}</label>
            {/* Switching the mode is a config write on this card; the core's own
                settings are edited on its own page, so the mode hint and the
                index line at the foot carry the operator there instead of
                expanding a second half that would need its own save. */}
            <SegGroup
              value={mode}
              onChange={v => patch({ mode: v as ProxyMode })}
              options={[
                { value: 'manual', label: t('proxy.modeManual') },
                { value: 'mihomo', label: t('proxy.modeMihomo') },
              ]}
            />
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '6px' }}>{t('proxy.modeHint')}</div>
          </div>

          {mode === 'manual' && (
            <div>
              <label style={fieldLabel}>{t('proxy.url')}</label>
              <input
                type="text"
                placeholder="http://user:pass@127.0.0.1:7890"
                value={proxy.url || ''}
                onChange={e => patch({ url: e.target.value })}
                className="input"
              />
            </div>
          )}

          {/* Destinations, not next steps: the core's own settings (only
              meaningful in mihomo mode) and the model-scoped routing rules.
              One quiet line rather than two bordered call-to-action rows — those
              competed with Save for the eye, and the page paragraph above
              already explains *why* they live elsewhere. Labels come from the
              nav so the wording cannot drift; the arrow (not a chevron) keeps
              two adjacent entries from reading as a breadcrumb path. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px 14px',
              flexWrap: 'wrap',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-dim)',
            }}
          >
            <span>{t('proxy.relatedPages')}</span>
            {mode === 'mihomo' && (
              <Link to="/proxy-clash" className="link-quiet">
                <span>{t('nav.proxyMihomo')}</span>
                <ArrowRight size={12} />
              </Link>
            )}
            <Link to="/proxy-patterns" className="link-quiet">
              <span>{t('nav.proxyPatterns')}</span>
              <ArrowRight size={12} />
            </Link>
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
              <span>{t('proxy.saveBtn')}</span>
            </button>
            {dirty && <span className="badge badge-warning">{t('proxy.unsaved')}</span>}
            <InfoTip text={t('proxy.saveHintMode')} />
          </div>
        </div>
      </div>
    </div>
  );
};
