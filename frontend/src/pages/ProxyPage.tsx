import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Play, RefreshCw, Save, Square } from 'lucide-react';
import { api, type MihomoProviderInfo, type MihomoProxyGroup, type MihomoProxyNode, type MihomoStatus, type MihomoSubscription } from '../lib/api';
import { DEFAULT_MIHOMO_CONTROLLER_PORT, DEFAULT_MIHOMO_GROUP, DEFAULT_MIHOMO_MIXED_PORT, DEFAULT_MIHOMO_SUB_INTERVAL_SEC } from '../lib/defaults';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { PatternListEditor } from '../components/PatternListEditor';
import { SegGroup } from '../components/SegGroup';
import { Combobox } from '../components/Combobox';
import { SearchInput } from '../components/SearchInput';
import { ScrollTable } from '../components/ScrollTable';

type ProxyMode = 'manual' | 'mihomo';
type Tab = 'general' | 'subscriptions' | 'nodes';

interface ProxyShape {
  enabled?: boolean;
  mode?: ProxyMode;
  url?: string;
  includes?: string[];
  excludes?: string[];
  mihomo?: {
    enabled?: boolean;
    binaryPath?: string;
    mixedPort?: number;
    controllerPort?: number;
    controllerSecret?: string;
    subscriptions?: MihomoSubscription[];
    selectedGroup?: string;
    selectedNodes?: Record<string, string>;
  };
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
  const confirm = useConfirm();
  const [proxy, setProxy] = useState<ProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>('general');
  const [status, setStatus] = useState<MihomoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [subs, setSubs] = useState<MihomoSubscription[]>([]);
  const [providers, setProviders] = useState<MihomoProviderInfo[]>([]);
  const [groups, setGroups] = useState<MihomoProxyGroup[]>([]);
  const [nodes, setNodes] = useState<MihomoProxyNode[]>([]);
  const [group, setGroup] = useState(DEFAULT_MIHOMO_GROUP);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState({ name: '', url: '', interval: String(DEFAULT_MIHOMO_SUB_INTERVAL_SEC), enabled: true, id: '' });

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.getMihomoStatus());
    } catch {
      // The card shows the last known status; a blip must not clear it.
    }
  }, []);

  const refreshSubs = useCallback(async () => {
    const body = await api.getMihomoSubscriptions();
    setSubs(body.subscriptions || []);
    setProviders(body.providers || []);
  }, []);

  const refreshNodes = useCallback(async () => {
    const body = await api.getMihomoProxies();
    setGroups(body.groups || []);
    setNodes(body.nodes || []);
    if (body.group) setGroup(body.group);
  }, []);

  useEffect(() => {
    api.getConfig().then(cfg => {
      const next = (cfg.proxy || {}) as ProxyShape;
      if (!next.mode) next.mode = 'manual';
      setProxy(next);
      setSubs(next.mihomo?.subscriptions || []);
      setLoading(false);
    }).catch(console.error);
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (proxy?.mode !== 'mihomo') return;
    const timer = window.setInterval(() => { void refreshStatus(); }, 4000);
    return () => window.clearInterval(timer);
  }, [proxy?.mode, refreshStatus]);

  useEffect(() => {
    if (tab === 'subscriptions') void refreshSubs().catch(console.error);
    if (tab === 'nodes') void refreshNodes().catch(console.error);
  }, [tab, refreshSubs, refreshNodes]);

  const mihomo = proxy?.mihomo ?? {};
  const mode: ProxyMode = proxy?.mode === 'mihomo' ? 'mihomo' : 'manual';

  const patch = (partial: Partial<ProxyShape>) => setProxy(prev => ({ ...(prev || {}), ...partial }));
  const patchMihomo = (partial: NonNullable<ProxyShape['mihomo']>) => setProxy(prev => ({
    ...(prev || {}),
    mihomo: { ...(prev?.mihomo || {}), ...partial },
  }));

  const handleSave = async () => {
    if (!proxy) return;
    setSaving(true);
    try {
      const next: ProxyShape = {
        ...proxy,
        mode,
        mihomo: { ...mihomo, enabled: mode === 'mihomo' },
      };
      await api.saveConfig({ proxy: next });
      setProxy(next);
      toast.success(t('proxy.savedNotice'));
      void refreshStatus();
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const runCore = async (action: 'start' | 'stop' | 'restart' | 'install') => {
    setBusy(action);
    try {
      if (action !== 'install' && proxy) {
        await api.saveConfig({ proxy: { ...proxy, mode, mihomo: { ...mihomo, enabled: mode === 'mihomo' } } });
      }
      const result = action === 'start' ? await api.startMihomo()
        : action === 'stop' ? await api.stopMihomo()
        : action === 'restart' ? await api.restartMihomo()
        : await api.installMihomo();
      if (result.ok === false || result.status === 'error') {
        toast.error(result.error || t('proxy.notRunning'));
      } else {
        toast.success(action === 'install' ? t('proxy.installed') : t('proxy.savedNotice'));
      }
      await refreshStatus();
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    const interval = Number(draft.interval);
    const body = {
      name: draft.name.trim(),
      url: draft.url.trim(),
      interval: Number.isFinite(interval) ? interval : DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
      enabled: draft.enabled,
    };
    setBusy('sub');
    try {
      if (draft.id) await api.updateMihomoSubscription(draft.id, body);
      else await api.addMihomoSubscription(body);
      setDraft({ name: '', url: '', interval: String(DEFAULT_MIHOMO_SUB_INTERVAL_SEC), enabled: true, id: '' });
      await refreshSubs();
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const removeSub = async (sub: MihomoSubscription) => {
    const ok = await confirm({ title: t('proxy.subDelete'), description: sub.name, danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await api.deleteMihomoSubscription(sub.id);
      await refreshSubs();
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    }
  };

  const refreshOne = async (id: string) => {
    setBusy(`refresh:${id}`);
    try {
      await api.refreshMihomoSubscription(id);
      await refreshSubs();
      toast.success(t('proxy.subRefresh'));
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    setBusy('refresh-all');
    try {
      const result = await api.refreshAllMihomoSubscriptions();
      await refreshSubs();
      if (result.failed?.length) toast.error(t('proxy.notRunning'));
      else toast.success(t('proxy.subRefreshAll'));
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const selectNode = async (name: string) => {
    setBusy(`select:${name}`);
    try {
      await api.selectMihomoProxy(group, name);
      setNodes(prev => prev.map(node => ({ ...node, selected: node.name === name })));
      patchMihomo({ selectedGroup: group, selectedNodes: { ...(mihomo.selectedNodes || {}), [group]: name } });
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const testNode = async (name: string) => {
    setBusy(`test:${name}`);
    try {
      const result = await api.testMihomoDelay(name, false);
      if (typeof result.delay === 'number') {
        setNodes(prev => prev.map(node => node.name === name ? { ...node, delay: result.delay! } : node));
      }
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const testAll = async () => {
    setBusy('test-all');
    try {
      const result = await api.testMihomoDelay(group, true);
      const delays = result.delays || {};
      setNodes(prev => prev.map(node => ({ ...node, delay: typeof delays[node.name] === 'number' ? delays[node.name] : node.delay })));
    } catch (err: any) {
      toast.error(`${t('common.failed')}: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const providerById = useMemo(() => {
    const map = new Map<string, MihomoProviderInfo>();
    for (const provider of providers) map.set(provider.name, provider);
    return map;
  }, [providers]);

  const visibleNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(node => node.name.toLowerCase().includes(q) || node.type.toLowerCase().includes(q));
  }, [nodes, query]);

  if (loading || !proxy) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <SegGroup
          value={tab}
          onChange={v => setTab(v as Tab)}
          size="lg"
          options={[
            { value: 'general', label: t('proxy.tabGeneral') },
            { value: 'subscriptions', label: t('proxy.tabSubscriptions') },
            { value: 'nodes', label: t('proxy.tabNodes') },
          ]}
        />
        {tab === 'general' && (
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            <Save size={14} />
            <span>{t('proxy.saveBtn')}</span>
          </button>
        )}
      </div>

      {tab === 'general' && (
        <div className="card">
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
              <SegGroup
                value={mode}
                onChange={v => {
                  const next = v as ProxyMode;
                  patch({ mode: next });
                  patchMihomo({ enabled: next === 'mihomo' });
                }}
                options={[
                  { value: 'manual', label: t('proxy.modeManual') },
                  { value: 'mihomo', label: t('proxy.modeMihomo') },
                ]}
              />
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '6px' }}>{t('proxy.modeHint')}</div>
            </div>

            {mode === 'manual' ? (
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
            ) : (
              <div style={{ border: '1px solid var(--divider)', borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 'var(--text-md)' }}>{t('proxy.statusTitle')}</strong>
                  <span style={{ fontSize: 'var(--text-xs)', color: status?.running ? 'var(--accent)' : 'var(--text-dim)' }}>
                    {status?.running ? t('proxy.running') : t('proxy.stopped')}
                    {' · '}
                    {status?.installed ? t('proxy.installed') : t('proxy.notInstalled')}
                    {status?.version ? ` · ${status.version}` : ''}
                    {status?.pid ? ` · ${t('proxy.pid')} ${status.pid}` : ''}
                  </span>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.coreHint')}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                  {status?.secretConfigured ? t('proxy.secretSet') : t('proxy.secretMissing')}
                </div>
                {status?.error && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{status.error}</div>}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void runCore('start')}><Play size={13} /><span>{t('proxy.start')}</span></button>
                  <button className="btn btn-sm" disabled={busy !== null} onClick={() => void runCore('stop')}><Square size={13} /><span>{t('proxy.stop')}</span></button>
                  <button className="btn btn-sm" disabled={busy !== null} onClick={() => void runCore('restart')}><RefreshCw size={13} /><span>{t('proxy.restart')}</span></button>
                  <button className="btn btn-sm" disabled={busy !== null} onClick={() => void runCore('install')}>
                    <span>{busy === 'install' ? t('proxy.installing') : t('proxy.install')}</span>
                  </button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={fieldLabel}>{t('proxy.mixedPort')}</label>
                    <input className="input" type="number" value={mihomo.mixedPort ?? DEFAULT_MIHOMO_MIXED_PORT} onChange={e => patchMihomo({ mixedPort: Number(e.target.value) })} />
                  </div>
                  <div>
                    <label style={fieldLabel}>{t('proxy.controllerPort')}</label>
                    <input className="input" type="number" value={mihomo.controllerPort ?? DEFAULT_MIHOMO_CONTROLLER_PORT} onChange={e => patchMihomo({ controllerPort: Number(e.target.value) })} />
                  </div>
                </div>
              </div>
            )}

            <PatternListEditor
              label={t('proxy.includes')}
              placeholder={t('proxy.pattern')}
              addLabel={t('proxy.addPattern')}
              patterns={proxy.includes || []}
              onChange={patterns => patch({ includes: patterns })}
            />
            <PatternListEditor
              label={t('proxy.excludes')}
              placeholder={t('proxy.pattern')}
              addLabel={t('proxy.addPattern')}
              patterns={proxy.excludes || []}
              onChange={patterns => patch({ excludes: patterns })}
            />
          </div>
        </div>
      )}

      {tab === 'subscriptions' && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="card-header">
            <div className="card-title"><span>{t('proxy.tabSubscriptions')}</span></div>
            <button className="btn btn-sm" disabled={busy !== null} onClick={() => void refreshAll()}>
              <RefreshCw size={13} />
              <span>{t('proxy.subRefreshAll')}</span>
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 120px auto', gap: '8px', alignItems: 'end' }}>
            <div>
              <label style={fieldLabel}>{t('proxy.subName')}</label>
              <input className="input" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <label style={fieldLabel}>{t('proxy.subUrl')}</label>
              <input className="input" value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="https://" />
            </div>
            <div>
              <label style={fieldLabel}>{t('proxy.subInterval')}</label>
              <input className="input" type="number" value={draft.interval} onChange={e => setDraft({ ...draft, interval: e.target.value })} />
            </div>
            <button className="btn btn-primary" disabled={busy === 'sub' || !draft.name.trim() || !draft.url.trim()} onClick={() => void saveDraft()}>
              {draft.id ? t('proxy.subEdit') : t('proxy.subAdd')}
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
            <Switch checked={draft.enabled} onChange={v => setDraft({ ...draft, enabled: v })} />
            <span>{t('proxy.subEnabled')}</span>
          </label>
          {subs.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.subEmpty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {subs.map(sub => {
                const info = providerById.get(sub.id);
                return (
                  <div key={sub.id} style={{ border: '1px solid var(--divider)', borderRadius: '8px', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{sub.name}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.url}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
                        {sub.enabled === false ? t('proxy.stopped') : t('proxy.subEnabled')}
                        {' · '}
                        {typeof info?.nodeCount === 'number' ? t('proxy.subNodes', { count: info.nodeCount }) : t('proxy.subNever')}
                        {info?.updatedAt ? ` · ${t('proxy.subUpdated', { time: info.updatedAt })}` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <button className="btn btn-sm" onClick={() => setDraft({ id: sub.id, name: sub.name, url: sub.url, interval: String(sub.interval ?? DEFAULT_MIHOMO_SUB_INTERVAL_SEC), enabled: sub.enabled !== false })}>{t('proxy.subEdit')}</button>
                      <button className="btn btn-sm" disabled={busy !== null} onClick={() => void refreshOne(sub.id)}>{t('proxy.subRefresh')}</button>
                      <button className="btn btn-sm" onClick={() => void removeSub(sub)}>{t('proxy.subDelete')}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'nodes' && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
          <div className="card-header">
            <div className="card-title"><span>{t('proxy.tabNodes')}</span></div>
            <button className="btn btn-sm" disabled={busy !== null} onClick={() => void testAll()}>{t('proxy.nodeTestAll')}</button>
          </div>
          {nodes.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.nodeEmpty')}</div>}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 220 }}>
              <Combobox
                value={group}
                onChange={value => {
                  setGroup(value);
                  void api.getMihomoProxies().then(body => {
                    const match = (body.groups || []).find(item => item.name === value);
                    if (!match) return;
                    setNodes(match.all.map(name => {
                      const found = (body.nodes || []).find(node => node.name === name);
                      return found || { name, type: 'Unknown', delay: null, selected: match.now === name };
                    }));
                  }).catch(console.error);
                }}
                options={(groups.length ? groups : [{ name: group, type: 'Selector', now: '', all: [] }]).map(item => ({ value: item.name, label: item.name, meta: item.type }))}
              />
            </div>
            <SearchInput value={query} onChange={setQuery} placeholder={t('proxy.nodeSearch')} />
          </div>
          <ScrollTable
            maxHeight={480}
            columns={[
              { key: 'name', label: t('proxy.subName') },
              { key: 'type', label: t('proxy.nodeType'), width: 120 },
              { key: 'delay', label: t('proxy.nodeTest'), width: 100 },
              { key: 'state', label: t('proxy.nodeSelected'), width: 90 },
              { key: 'actions', label: '', width: 180 },
            ]}
            empty={query ? t('common.noResults') : undefined}
          >
            {visibleNodes.map(node => (
              <tr key={node.name}>
                <td style={{ padding: '8px 10px' }}>{node.name}</td>
                <td style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>{node.name === 'DIRECT' ? t('proxy.direct') : node.type}</td>
                <td style={{ padding: '8px 10px' }}>{typeof node.delay === 'number' ? t('proxy.nodeDelay', { ms: node.delay }) : '—'}</td>
                <td style={{ padding: '8px 10px', color: node.selected ? 'var(--accent)' : 'var(--text-dim)' }}>{node.selected ? t('proxy.nodeSelected') : ''}</td>
                <td style={{ padding: '8px 10px' }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="btn btn-sm" disabled={busy !== null || node.selected} onClick={() => void selectNode(node.name)}>{t('proxy.nodeSelect')}</button>
                    <button className="btn btn-sm" disabled={busy !== null} onClick={() => void testNode(node.name)}>{t('proxy.nodeTest')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </ScrollTable>
        </div>
      )}
    </div>
  );
};
