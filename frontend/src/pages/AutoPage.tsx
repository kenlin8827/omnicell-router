import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BrainCircuit, Save, Check, Cpu, Scale, Network, Database, ArrowRight, Zap, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';

/**
 * /auto — Auto virtual-model routing (decision layer).
 * Aggregates: routing.mode, Layer1 classifier, Layer2 Judge + decision cache.
 * Tier composition lives at /tiers; cache stats at /cache; hit traces at /traces.
 */
export const AutoPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    api.getConfig().then(data => {
      setConfig(data);
      setLoading(false);
    }).catch(console.error);
  }, []);

  const handleSave = async () => {
    try {
      await api.saveConfig(config);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 5000);
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    }
  };

  if (loading || !config) {
    return <div style={{ color: 'var(--text-dim)' }}>Loading...</div>;
  }

  const layer2 = config.classifier?.layer2 || {};
  const setLayer2 = (patch: any) =>
    setConfig({ ...config, classifier: { ...config.classifier, layer2: { ...layer2, ...patch } } });
  const decisionCache = layer2.decisionCache || {};
  const setDecisionCache = (patch: any) => setLayer2({ decisionCache: { ...decisionCache, ...patch } });

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.02)',
    padding: '16px',
    borderRadius: '10px',
    border: '1px solid var(--card-border)',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  };
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', cursor: 'pointer' };
  const labelStyle: React.CSSProperties = { fontSize: '11px', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <BrainCircuit size={18} color="var(--accent)" />
            <span>{t('auto.title')}</span>
          </div>
          <button className="btn btn-primary" onClick={handleSave}>
            <Save size={14} />
            <span>{t('settings.saveBtn')}</span>
          </button>
        </div>

        {savedNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{t('settings.savedNotice')}</span>
          </div>
        )}
        {savedNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.3)', color: 'var(--accent-amber)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <TriangleAlert size={14} />
            <span>{t('auto.restartNotice')}</span>
          </div>
        )}

        {/* Alias family overview */}
        <div style={{ padding: '14px', borderRadius: '10px', border: '1px dashed var(--card-border)', display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
          {(['famAuto', 'famFast', 'famFlagship', 'famReasoning'] as const).map(k => (
            <div key={k} style={{ flex: '1 1 200px', fontSize: '12px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={13} color="var(--accent)" />
              <span>{t('auto.' + k)}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
          {/* Card A: Routing mode */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Network size={14} />
              {t('auto.modeTitle')}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['smart', 'cost', 'quality'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  className={(config.routing?.mode ?? 'smart') === m ? 'btn btn-primary' : 'btn'}
                  style={{ fontSize: '12px', flex: 1 }}
                  onClick={() => setConfig({ ...config, routing: { ...(config.routing || {}), mode: m } })}
                >
                  {t(m === 'smart' ? 'auto.modeSmart' : m === 'cost' ? 'auto.modeCost' : 'auto.modeQuality')}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{t('auto.modeHint')}</div>
          </div>

          {/* Card B: Layer 1 classifier */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-amber)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Cpu size={14} />
              {t('auto.layer1Title')}
            </div>
            <label style={rowStyle}>
              <span>{t('auto.layer1Enable')}</span>
              <Switch
                checked={config.classifier?.localModel?.enabled ?? false}
                onChange={v => setConfig({ ...config, classifier: { ...config.classifier, localModel: { ...(config.classifier?.localModel || {}), enabled: v } } })}
              />
            </label>
            <div>
              <label style={labelStyle}>{t('auto.layer1Thresh')}</label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={config.classifier?.localModel?.confidenceThreshold || 0.85}
                onChange={e => setConfig({ ...config, classifier: { ...config.classifier, localModel: { ...(config.classifier?.localModel || {}), confidenceThreshold: parseFloat(e.target.value) || 0.85 } } })}
                className="input"
              />
            </div>
          </div>

          {/* Card C: Layer 2 Judge + decision cache */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-violet)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Scale size={14} />
              {t('auto.layer2Title')}
            </div>
            <label style={rowStyle}>
              <span>{t('auto.layer2Enable')}</span>
              <Switch
                checked={layer2.enabled ?? false}
                onChange={v => setLayer2({ enabled: v })}
              />
            </label>
            <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <label style={rowStyle}>
                <span>{t('auto.cacheEnable')}</span>
                <Switch
                  checked={decisionCache.enabled ?? true}
                  onChange={v => setDecisionCache({ enabled: v })}
                />
              </label>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>{t('auto.cacheTtl')}</label>
                  <input
                    type="number"
                    value={decisionCache.ttlSeconds ?? 1800}
                    onChange={e => setDecisionCache({ ttlSeconds: parseInt(e.target.value, 10) || 1800 })}
                    className="input"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>{t('auto.cacheMax')}</label>
                  <input
                    type="number"
                    value={decisionCache.maxEntries ?? 500}
                    onChange={e => setDecisionCache({ maxEntries: parseInt(e.target.value, 10) || 500 })}
                    className="input"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Card D: quick links along the chain */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-emerald)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Database size={14} />
              {t('auto.linksTitle')}
            </div>
            {([
              { to: '/tiers', label: t('auto.linkTiers') },
              { to: '/cache', label: t('auto.linkCache') },
              { to: '/sessions', label: t('auto.linkSessions') },
            ]).map(l => (
              <Link key={l.to} to={l.to} className="btn" style={{ fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{l.label}</span>
                <ArrowRight size={13} />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
