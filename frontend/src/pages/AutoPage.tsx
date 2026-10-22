import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BrainCircuit, Save, Check, Scale, Network, Database, ArrowRight, Zap, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { Switch } from '../components/Switch';
import { Combobox } from '../components/Combobox';
import { sortModelOptions } from '../lib/model-options';

/**
 * /auto — Auto virtual-model routing (decision layer).
 * Aggregates: routing.mode, Layer 2 Decision + decision cache.
 * Tier composition lives at /tiers; cache stats at /cache; hit traces at /traces.
 */
export const AutoPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [savedNotice, setSavedNotice] = useState(false);
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [decisionOutcome, setDecisionOutcome] = useState<{ ts: number; modelId: string; ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    api.getConfig().then(data => {
      setConfig(data);
      setLoading(false);
    }).catch(console.error);
    // Registered physical models only (kind 'model') — the decision layer resolves ids
    // through registry.getModel, so virtual aliases/combos/variants would
    // leave it permanently inert.
    api.listGatewayModels().then(ms =>
      setModelOptions(sortModelOptions(ms.filter(m => m.kind === 'model').map(m => ({ value: m.id, label: m.id }))))
    ).catch(() => {});
    // Last decision wire attempt — a failure stays visible until a real attempt
    // succeeds (cache hits never clear it). Light poll so the warning tracks
    // reality (e.g. a rate-limit reset makes it disappear on its own).
    const poll = () => api.getDecisionOutcome().then(setDecisionOutcome).catch(() => {});
    poll();
    const t = setInterval(poll, 30_000);
    return () => clearInterval(t);
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
  // What the decision layer would actually call: its own model wins, else the System
  // One surface default (systemone.defaultModel, edited on the Settings page
  // — read-only here). Both unset = the decision layer never answers (warns once,
  // every auto request serves the plus baseline, no experience is recorded).
  const effectiveDecisionModel: string = (layer2.model || config.systemone?.defaultModel || '').trim();

  // Surface = global .sub-card; only the flex layout stays local.
  const cardStyle: React.CSSProperties = {
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
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-emerald) 30%, transparent)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{t('settings.savedNotice')}</span>
          </div>
        )}

        {/* Alias family overview */}
        <div style={{ padding: '14px', borderRadius: '10px', border: '1px dashed var(--card-border)', display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
          {(['famAuto', 'famLite', 'famPlus', 'famPro', 'famUltra'] as const).map(k => (
            <div key={k} style={{ flex: '1 1 200px', fontSize: '12px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={13} color="var(--accent)" />
              <span>{t('auto.' + k)}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
          {/* Card A: Routing mode */}
          <div className="sub-card" style={cardStyle}>
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

          {/* Card B: Layer 2 Decision + decision cache */}
          <div className="sub-card" style={cardStyle}>
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
            {/* Decision-model resolution (ADR-0001 cascade): a decision layer that
                names nothing can never answer — classifier.layer2.model wins,
                else systemone.defaultModel (configured on the Settings page —
                it is the /v1/systemone surface default, not a routing knob),
                else inert with a one-time warn. Surfacing the resolution here
                is the console-side fix for "enabled but silently dead". */}
            <div>
              <label style={labelStyle}>{t('auto.l2ModelLabel')}</label>
              <Combobox
                value={layer2.model ?? ''}
                onChange={(v: string) => setLayer2({ model: v || undefined })}
                options={modelOptions}
                clearable
                placeholder={t('auto.l2ModelFollow')}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '4px' }}>
                {t('auto.l2ModelHint')}
              </div>
            </div>
            <div>
              <label style={labelStyle}>{t('auto.l2TimeoutLabel')}</label>
              <input
                type="number"
                min={500}
                step={500}
                value={layer2.timeoutMs ?? 5000}
                onChange={e => setLayer2({ timeoutMs: parseInt(e.target.value, 10) || undefined })}
                className="input"
                style={{ width: 140 }}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '4px' }}>
                {t('auto.l2TimeoutHint')}
              </div>
            </div>
            <div>
              <label style={rowStyle}>
                <span>{t('auto.l2EffortDecision')}</span>
                <Switch
                  checked={layer2.effortDecision ?? false}
                  onChange={v => setLayer2({ effortDecision: v })}
                />
              </label>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('auto.l2EffortDecisionHint')}
              </div>
            </div>
            {(layer2.enabled ?? false) && effectiveDecisionModel && (
              <div style={{ fontSize: '11px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Check size={13} />
                <span>{t('auto.l2ModelEffective', { model: effectiveDecisionModel })}</span>
              </div>
            )}
            {(layer2.enabled ?? false) && !effectiveDecisionModel && (
              <div style={{ fontSize: '11px', color: 'var(--accent-amber)', display: 'flex', alignItems: 'center', gap: '6px', lineHeight: 1.6 }}>
                <TriangleAlert size={13} style={{ flexShrink: 0 }} />
                <span>{t('auto.l2ModelUnset')}</span>
              </div>
            )}
            {(layer2.enabled ?? false) && decisionOutcome && !decisionOutcome.ok && (
              <div style={{ fontSize: '11px', color: 'var(--accent-red, #f87171)', display: 'flex', alignItems: 'flex-start', gap: '6px', lineHeight: 1.6, padding: '6px 8px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--accent-red, #f87171) 30%, transparent)', background: 'color-mix(in srgb, var(--accent-red, #f87171) 8%, transparent)' }}>
                <TriangleAlert size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  {t('auto.decisionLastFail', {
                    error: decisionOutcome.error || 'unknown',
                    time: new Date(decisionOutcome.ts).toLocaleTimeString(),
                  })}
                </span>
              </div>
            )}
            {/* Distillation dataset — NOT the request-capture leg (that moved to
                requestCapture.systemone.l2DecisionEnabled on the Settings page).
                Opt-in: the recorded state carries user conversation content.
                setLayer2 spreads the full layer2 node, so model / timeoutMs /
                decisionCache survive this write (save shallow-merges nodes). */}
            <div>
              <label style={rowStyle}>
                <span>{t('auto.l2CollectEnable')}</span>
                <Switch
                  checked={layer2.collectEnabled ?? false}
                  onChange={v => setLayer2({ collectEnabled: v })}
                />
              </label>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '6px' }}>
                {t('auto.l2CollectHint')}
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
          <div className="sub-card" style={cardStyle}>
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
