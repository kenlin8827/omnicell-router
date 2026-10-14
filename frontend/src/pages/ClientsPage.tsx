import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Terminal, Check, X, RefreshCw, Undo2, ArrowUpRight, RotateCcw, ChevronDown, Puzzle, Eraser } from 'lucide-react';
import { BrandIcon } from '../components/BrandIcons';
import { Combobox } from '../components/Combobox';
import { api, type ClientStatus, type ApiKeyItem, type ModelProfileView, type OpenCodeAgentView, type ClientProfileMemoryEntry } from '../lib/api';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';

/**
 * Slots to render for a client. An explicit `[]` means the client is
 * slot-less by design (opencode-proxy routes traffic transparently and keeps
 * opencode-native models — no model picker). A MISSING field means the
 * backend predates modelSlots (old gateway process) — fall back to a single
 * `main` slot so the selector never disappears from the UI.
 */
const clientSlots = (c: ClientStatus): { key: string; value?: string; default?: string }[] => {
  if (c.modelSlots === undefined) return [{ key: 'main', default: 'auto' }];
  return c.modelSlots;
};

export const ClientsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  /** Per-client per-slot model selection ('auto' = intelligent routing default) */
  const [modelSel, setModelSel] = useState<Record<string, Record<string, string>>>({});
  /** Gateway-routable models (virtual + registered) from /v1/models */
  const [models, setModels] = useState<{ id: string; tier?: string }[]>([]);
  /** Gateway API keys (Claude auth token writer) */
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  /** Per-client selected API key ('' = keep current token) */
  const [apiKeySel, setApiKeySel] = useState<Record<string, string>>({});
  /** Per-client context window in tokens (claude compaction envs; default 256K) */
  const [ctxSel, setCtxSel] = useState<Record<string, string>>({});
  /** Per-client extra concrete models (opencode provider models list) */
  const [extraSel, setExtraSel] = useState<Record<string, string[]>>({});
  /** Draft value of the extra-model add Combobox */
  const [extraDraft, setExtraDraft] = useState<Record<string, string>>({});
  /** Per-client model-list source: 'none' (default) exposes no concrete
   *  models, 'follow' mirrors the selected API key's effective access,
   *  'custom' keeps the manual picker. */
  const [modeSel, setModeSel] = useState<Record<string, 'none' | 'custom' | 'follow'>>({});
  /** keyId → effective-model view cache (follow mode, lazy-loaded) */
  const [keyModels, setKeyModels] = useState<Record<string, Awaited<ReturnType<typeof api.getKeyModels>>>>({});
  /** Model profiles (config.yaml `modelProfiles`) for the opencode agent binding UI */
  const [profiles, setProfiles] = useState<ModelProfileView[]>([]);
  /** Profiles fetch settled — the seed effect must not judge memory against a
   *  list that is merely still loading (empty ≠ none). */
  const [profilesReady, setProfilesReady] = useState(false);
  /** OpenCode agent inventory (lazy: loaded when the opencode form expands) */
  const [agents, setAgents] = useState<OpenCodeAgentView[] | null>(null);
  /** Selected profile id per client ('' = no profile / un-apply) */
  const [profileSel, setProfileSel] = useState<Record<string, string>>({});
  /** Per-client agent-name → slot-key bindings (model profile application) */
  const [bindSel, setBindSel] = useState<Record<string, Record<string, string>>>({});
  /** Agent inventory filter box (binding table gets long with 25+ agents) */
  const [agentFilter, setAgentFilter] = useState('');
  /** Environment-persisted form memory (config.yaml `clientProfileMemory`) */
  const [mem, setMem] = useState<Record<string, ClientProfileMemoryEntry> | null>(null);

  const ctxOptions = [
    { value: '262144', label: `256K ${t('clients.ctxDefault')}` },
    { value: '131072', label: '128K' },
    { value: '200000', label: '200K' },
    { value: '1048576', label: '1M' },
  ];
  /** Accordion: which client's config form is expanded */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** Seeds the default expansion (first un-hooked client) exactly once, on initial load */
  const didSeedExpand = useRef(false);
  /** Live gateway port for the manual-endpoint guide ('' → fall back to console origin / OCR default). */
  const [port, setPort] = useState<string>('');
  const gwPort = port || window.location.port || '4000';

  const loadClients = async () => {
    try {
      const data = await api.getStatus();
      setClients(data.clients || []);
      if (data.port) setPort(String(data.port));
      // Progressive setup: with nothing hooked yet, pre-expand the first candidate so
      // its form is visible; once anything is hooked, keep everything collapsed.
      if (!didSeedExpand.current) {
        didSeedExpand.current = true;
        if (!(data.clients || []).some(c => c.hooked)) {
          const first = (data.clients || []).find(c => !c.hooked);
          if (first) setExpanded({ [first.name]: true });
        }
      }
      // Seed selections from the client config's current slot values (don't clobber unsaved edits)
      setModelSel(prev => {
        const next = { ...prev };
        for (const c of data.clients || []) {
          if (next[c.name] === undefined) {
            const slots: Record<string, string> = {};
            for (const s of clientSlots(c)) slots[s.key] = s.value || s.default || 'auto';
            next[c.name] = slots;
          }
        }
        return next;
      });
      setExtraSel(prev => {
        const next = { ...prev };
        for (const c of data.clients || []) {
          if (next[c.name] === undefined) next[c.name] = c.extraModels || [];
        }
        return next;
      });
      // Profile selections seed from a dedicated effect (applied echo wins,
      // then the environment memory) — both sources must be loaded first.
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadClients();
    api.listGatewayModels().then(setModels).catch(() => {});
    api.getApiKeys().then(r => setApiKeys((r.keys || []).filter(k => k.enabled))).catch(() => {});
    api.getModelProfiles().then(p => { setProfiles(p); setProfilesReady(true); }).catch(() => setProfilesReady(true));
    api.getClientProfileMemory().then(setMem).catch(() => setMem({}));
  }, []);

  /** Seed profile selections once BOTH sources are in: the applied echo (live
   *  truth while hooked) wins, else the environment-persisted memory restores
   *  the last picked profile + slot mapping. Per-client undefined guard never
   *  clobbers in-page edits. */
  useEffect(() => {
    if (mem === null || !profilesReady) return;
    setProfileSel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (next[c.name] !== undefined) continue;
        // Stale-memory defense: an id pointing at a DELETED profile restores as
        // "no profile" — the combobox must never seed a non-existent option.
        const candidate = c.profile?.id || mem[c.name]?.profile || '';
        next[c.name] = candidate && profiles.some(p => p.id === candidate) ? candidate : '';
      }
      return next;
    });
    setBindSel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (next[c.name] === undefined) next[c.name] = c.profile?.bindings || mem[c.name]?.bindings || {};
      }
      return next;
    });
    setModeSel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        // Seeding heuristic: memory wins; an already-hooked client WITH extra
        // models falls back to 'custom' (never default a live list to 'none' —
        // that would silently wipe it on the next setup); empty config → 'none'.
        if (next[c.name] === undefined) {
          next[c.name] = mem[c.name]?.modelMode || (c.extraModels && c.extraModels.length > 0 ? 'custom' : 'none');
        }
      }
      return next;
    });
  }, [clients, mem, profilesReady, profiles]);

  /** Write-through form memory into the ACTIVE environment's config.yaml
   *  (book-set scoped per ADR-0017 — switching envs switches the memory too). */
  const persistMem = (clientName: string, profile: string, bindings: Record<string, string>, modelMode?: 'none' | 'custom' | 'follow') => {
    const mode = modelMode ?? modeSel[clientName] ?? 'none';
    // Pure updater required: computing `next` (and firing the POST) inside the
    // setMem updater would double-invoke under StrictMode / concurrent render.
    const next = { ...(mem || {}), [clientName]: { profile, bindings, modelMode: mode } };
    setMem(next);
    api.saveClientProfileMemory(next).catch(e => console.warn('profile memory save failed:', e));
  };

  /** The key object behind a client's apiKey selection ('' = keep token → none). */
  const followKeyOf = (clientName: string): ApiKeyItem | undefined =>
    apiKeys.find(k => k.key === (apiKeySel[clientName] || ''));

  /** Effective extras for a followed key: its allowed non-virtual models. */
  const followExtrasOf = (k: ApiKeyItem): string[] =>
    (keyModels[k.id]?.models || []).filter(m => !m.virtual && m.allowed).map(m => m.id);

  /** Flip the model-list source and write it through to the form memory. */
  const setModelMode = (clientName: string, mode: 'none' | 'custom' | 'follow') => {
    setModeSel(prev => ({ ...prev, [clientName]: mode }));
    persistMem(clientName, profileSel[clientName] || '', bindSel[clientName] || {}, mode);
  };

  /** Lazy-load the effective-model view when a follow selection has a key picked. */
  useEffect(() => {
    for (const c of clients) {
      if (modeSel[c.name] !== 'follow') continue;
      const k = followKeyOf(c.name);
      if (!k || keyModels[k.id]) continue;
      api.getKeyModels(k.id).then(v => setKeyModels(prev => ({ ...prev, [k.id]: v }))).catch(() => {});
    }
  }, [clients, modeSel, apiKeySel, apiKeys, keyModels]);

  /** Lazy-load the OpenCode agent inventory when the opencode form first expands. */
  const opencodeOpen = !!expanded['opencode'];
  useEffect(() => {
    if (opencodeOpen && agents === null) {
      api.listOpencodeAgents().then(setAgents).catch(() => setAgents([]));
    }
  }, [opencodeOpen, agents]);

  const handleToggle = async (clientName: string, action: 'setup' | 'teardown') => {
    setLoading(true);
    try {
      let extras = extraSel[clientName] || [];
      if (action === 'setup' && clientName === 'opencode') {
        const mode = modeSel[clientName] ?? 'none';
        if (mode === 'none') {
          // Explicit 'none': the switcher keeps only the auto* virtual entries.
          extras = [];
        } else if (mode === 'follow') {
          // Follow mode: the hook exposes exactly the models the picked key can use
          // (snapshot at setup — the key's policy is the single source of truth).
          const k = followKeyOf(clientName);
          if (!k) {
            toast.error(t('clients.followNoKey'));
            return;
          }
          const view = keyModels[k.id] || (await api.getKeyModels(k.id));
          setKeyModels(prev => (prev[k.id] ? prev : { ...prev, [k.id]: view }));
          extras = view.models.filter(m => !m.virtual && m.allowed).map(m => m.id);
        }
      }
      const res = await api.toggleClient(clientName, action, action === 'setup' ? {
        models: modelSel[clientName] || {},
        apiKey: apiKeySel[clientName] || undefined,
        contextWindow: Number(ctxSel[clientName] || '262144'),
        extraModels: extras,
        ...opencodeProfilePayload(clientName),
      } : undefined);
      setActionNotice(res.message || 'Updated');
      // Commit-point memory: the environment remembers the selection THIS
      // setup just applied — never half-edited drafts (per-click config
      // writes would storm the hot-apply pipeline for a UI nicety).
      if (action === 'setup') {
        persistMem(clientName, profileSel[clientName] || '', bindSel[clientName] || {});
      }
      // Refresh the agent inventory cache so the binding table's "current model"
      // column reflects what this apply just wrote (the lazy-load effect refetches).
      if (clientName === 'opencode') setAgents(null);
      await loadClients();
      setTimeout(() => setActionNotice(null), 3000);
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Model-profile payload for the opencode setup call. Rules:
   *  - a selected profile id  → apply it with the current bindings;
   *  - profile id cleared while one was applied → explicit un-apply (id ''
   *    sweeps router-owned agent overrides);
   *  - never selected anything → omit `profile` entirely (bare setup keeps the
   *    legacy subagent-slot behavior and never touches agent bindings).
   */
  const opencodeProfilePayload = (clientName: string): { profile?: { id: string; bindings: Record<string, string> } } => {
    if (clientName !== 'opencode') return {};
    const sel = profileSel[clientName] ?? '';
    if (sel) return { profile: { id: sel, bindings: bindSel[clientName] || {} } };
    const applied = clients.find(c => c.name === clientName)?.profile?.id;
    return applied ? { profile: { id: '', bindings: {} } } : {};
  };

  /** Reset ALL slots to their role-recommended defaults; re-apply immediately when currently hooked. */
  const handleResetModel = async (clientName: string) => {
    const c = clients.find(x => x.name === clientName);
    const cleared = Object.fromEntries(
      clientSlots(c || ({ name: clientName } as ClientStatus)).map(s => [s.key, s.default || 'auto'])
    );
    setModelSel(prev => ({ ...prev, [clientName]: cleared }));
    setExtraSel(prev => ({ ...prev, [clientName]: [] }));
    setProfileSel(prev => ({ ...prev, [clientName]: '' }));
    setBindSel(prev => ({ ...prev, [clientName]: {} }));
    setModeSel(prev => ({ ...prev, [clientName]: 'none' }));
    persistMem(clientName, '', {}, 'none');
    if (clients.find(c => c.name === clientName)?.hooked) {
      setLoading(true);
      try {
        const res = await api.toggleClient(clientName, 'setup', {
          models: cleared,
          extraModels: [],
          ...(clientName === 'opencode' && clients.find(c => c.name === clientName)?.profile?.id ? { profile: { id: '', bindings: {} } } : {}),
        });
        setActionNotice(res.message || 'Updated');
        await loadClients();
        setTimeout(() => setActionNotice(null), 3000);
      } catch (err: any) {
        toast.error('Failed: ' + err.message);
      } finally {
        setLoading(false);
      }
    }
  };

  const slotLabels: Record<string, string> = {
    main: t('clients.slotMain'),
    opus: t('clients.slotOpus'),
    sonnet: t('clients.slotSonnet'),
    haiku: t('clients.slotHaiku'),
    fable: t('clients.slotFable'),
    subagent: t('clients.slotSubagent'),
  };

  const modelOptions = [
    { value: 'auto', label: t('clients.modelAuto') },
    ...models
      .filter(m => m.id !== 'auto')
      .map(m => ({ value: m.id, label: m.id })),
  ];

  const addExtraModel = (clientName: string, id: string) => {
    if (!id) return;
    setExtraSel(prev => {
      const list = prev[clientName] || [];
      return list.includes(id) ? prev : { ...prev, [clientName]: [...list, id] };
    });
    setExtraDraft(prev => ({ ...prev, [clientName]: '' }));
  };

  const removeExtraModel = (clientName: string, id: string) => {
    setExtraSel(prev => ({ ...prev, [clientName]: (prev[clientName] || []).filter(m => m !== id) }));
  };

  const extraOptions = (clientName: string) =>
    models
      .filter(m => !m.id.startsWith('auto') && !(extraSel[clientName] || []).includes(m.id))
      .map(m => ({ value: m.id, label: m.id }));

  /** Primary takeover/teardown button; `stretched` fills the form's action row. */
  const renderActionButtons = (c: ClientStatus, stretched: boolean) =>
    c.hooked ? (
      <button
        className="btn btn-danger btn-sm"
        style={stretched ? { flex: 1 } : undefined}
        onClick={e => { e.stopPropagation(); handleToggle(c.name, 'teardown'); }}
        disabled={loading}
      >
        <Undo2 size={12} />
        <span>{t('clients.teardownBtn')}</span>
      </button>
    ) : (
      <button
        className="btn btn-primary btn-sm"
        style={stretched ? { flex: 1 } : undefined}
        onClick={e => { e.stopPropagation(); handleToggle(c.name, 'setup'); }}
        disabled={loading}
      >
        <ArrowUpRight size={12} />
        <span>{t('clients.setupBtn')}</span>
      </button>
    );

  /** Accordion state for the static "Other clients" manual-setup row ('other' can't collide with adapter names). */
  const otherOpen = !!expanded['other'];
  const toggleOther = () => setExpanded(prev => ({ ...prev, other: !otherOpen }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="card">
        <div className="card-header">
          <div className="card-title">
            <Terminal size={18} color="var(--accent)" />
            <span>{t('clients.title')}</span>
          </div>
          <button className="btn btn-sm" onClick={loadClients} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('clients.refresh')}</span>
          </button>
        </div>

        {actionNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-emerald) 30%, transparent)', color: 'var(--accent-emerald)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{actionNotice}</span>
          </div>
        )}

        <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '20px' }}>
          {t('clients.desc')}
        </p>

        {/* Accordion: one full-width row per client — collapsed shows identity + status +
            quick action, expanding reveals the progressive setup form. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {clients.map(c => {
            const open = !!expanded[c.name];
            const toggle = () => setExpanded(prev => ({ ...prev, [c.name]: !open }));
            return (
              <div
                key={c.name}
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--card-border)',
                  borderRadius: '10px',
                  overflow: 'hidden',
                }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={toggle}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 18px', cursor: 'pointer', userSelect: 'none' }}
                >
                  <ChevronDown
                    size={16}
                    color="var(--text-dim)"
                    style={{ flexShrink: 0, transition: 'transform 0.15s ease', transform: open ? 'rotate(180deg)' : 'none' }}
                  />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 700 }}>
                    <BrandIcon name={c.name === 'opencode-proxy' ? 'opencode' : c.name} size={18} />
                    {c.name === 'opencode-proxy' ? t('clients.nameOpencodeProxy') : c.displayName}
                  </span>
                  <span
                    title={c.configPath}
                    style={{ flex: 1, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {c.configPath}
                  </span>
                  {c.hooked ? (
                    <span className="badge badge-success">{t('overview.hooked')}</span>
                  ) : (
                    <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
                      {t('overview.notHooked')}
                    </span>
                  )}
                  {!open && renderActionButtons(c, false)}
                </div>

                {open && (
                  <div style={{ padding: '16px 18px', borderTop: '1px solid var(--divider)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                      {t('clients.configPath')}
                      <div style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '11px', color: 'var(--text-muted)', wordBreak: 'break-all', marginTop: '3px' }}>
                        {c.configPath}
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', color: 'var(--text-dim)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {c.exists ? <Check size={12} color="var(--accent-emerald)" /> : <X size={12} color="var(--text-dim)" />}
                        <span>{t('clients.fileExists')} {c.exists ? t('clients.yes') : t('clients.no')}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {c.backupExists ? <Check size={12} color="var(--accent-emerald)" /> : <X size={12} color="var(--text-dim)" />}
                        <span>{t('clients.backupExists')} {c.backupExists ? t('clients.ready') : t('clients.none')}</span>
                      </div>
                    </div>

                    {c.name === 'opencode-proxy' && (
                      <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, borderLeft: '2px solid var(--accent)', paddingLeft: '10px' }}>
                        {t('clients.proxyHint')}
                      </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
                {c.name !== 'opencode-proxy' && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>{t('clients.apiKey')}</div>
                    <Combobox
                      value={apiKeySel[c.name] || ''}
                      onChange={v => setApiKeySel(prev => ({ ...prev, [c.name]: v }))}
                      options={[
                        { value: '', label: t('clients.apiKeyKeep') },
                        ...apiKeys.map(k => ({ value: k.key, label: k.name, meta: k.key.length > 8 ? `…${k.key.slice(-4)}` : undefined })),
                      ]}
                    />
                  </div>
                )}
                      {c.name === 'claude' && (
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>{t('clients.contextWindow')}</div>
                    <Combobox
                      value={ctxSel[c.name] || '262144'}
                      onChange={v => setCtxSel(prev => ({ ...prev, [c.name]: v }))}
                      options={ctxOptions}
                    />
                  </div>
                )}
                {clientSlots(c).map(s => (
                        <div key={s.key}>
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>
                            {slotLabels[s.key] || s.key}
                          </div>
                          <Combobox
                            value={modelSel[c.name]?.[s.key] || 'auto'}
                            onChange={v =>
                              setModelSel(prev => ({
                                ...prev,
                                [c.name]: { ...(prev[c.name] || {}), [s.key]: v || 'auto' },
                              }))
                            }
                            options={modelOptions}
                            panelMinWidth={360}
                            // while a profile owns the agent node, 'general' binds via the mapping table
                            disabled={c.name === 'opencode' && s.key === 'subagent' && !!(profileSel[c.name] || '')}
                          />
                        </div>
                      ))}
                      {c.name === 'opencode' && (() => {
                        const mode = modeSel[c.name] ?? 'none';
                        const follow = mode === 'follow';
                        const fk = follow ? followKeyOf(c.name) : undefined;
                        const followLoaded = !!fk && !!keyModels[fk.id];
                        const followList = fk && followLoaded ? followExtrasOf(fk) : [];
                        return (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.models')}</div>
                            <div style={{ display: 'inline-flex', gap: '4px' }}>
                              {(['none', 'custom', 'follow'] as const).map(m => (
                                <button
                                  key={m}
                                  className="btn btn-sm"
                                  onClick={() => setModelMode(c.name, m)}
                                  disabled={loading}
                                  style={mode === m
                                    ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
                                    : undefined}
                                >
                                  <span>{t(m === 'none' ? 'clients.modelModeNone' : m === 'custom' ? 'clients.modelModeCustom' : 'clients.modelModeFollow')}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                          {follow ? (
                            <>
                              {!fk && (
                                <div style={{ fontSize: '11px', color: 'var(--accent-amber)' }}>{t('clients.followNoKey')}</div>
                              )}
                              {!!fk && !followLoaded && (
                                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.followLoading')}</div>
                              )}
                              {followLoaded && (
                                <>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
                                    {followList.map(id => (
                                      <span key={id} style={{ padding: '3px 10px', borderRadius: '999px', border: '1px solid var(--card-border)', fontSize: '11px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                                        {id}
                                      </span>
                                    ))}
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                                    {t('clients.followCount', { n: followList.length })} · {t('clients.followSnapshot')}
                                  </div>
                                </>
                              )}
                            </>
                          ) : mode === 'none' ? (
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.modelModeNoneHint')}</div>
                          ) : (
                            <>
                              {(extraSel[c.name] || []).length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
                                  {(extraSel[c.name] || []).map(id => (
                                    <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px', border: '1px solid var(--card-border)', fontSize: '11px', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace" }}>
                                      {id}
                                      <button onClick={() => removeExtraModel(c.name, id)} style={{ display: 'inline-flex', cursor: 'pointer', color: 'var(--text-dim)', background: 'none', border: 'none', padding: 0 }}>
                                        <X size={10} />
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                              <Combobox
                                value={extraDraft[c.name] || ''}
                                onChange={v => addExtraModel(c.name, v)}
                                options={extraOptions(c.name)}
                                placeholder={t('clients.addModel')}
                                panelMinWidth={360}
                              />
                            </>
                          )}
                        </div>
                        );
                      })()}
                    </div>

                {c.name === 'opencode' && (() => {
                  const selProfileId = profileSel[c.name] || '';
                  const profile = profiles.find(p => p.id === selProfileId);
                  const slotKeys = profile ? Object.keys(profile.slots || {}) : [];
                  const bindings = bindSel[c.name] || {};
                  // Switching profiles keeps the agent→slot-name selections; same-name
                  // slots carry over silently (the point of stable slot naming), stale
                  // references are surfaced here and SKIPPED by the backend at apply.
                  const keptCount = agents?.filter(a => bindings[a.name] && slotKeys.includes(bindings[a.name])).length ?? 0;
                  const missingCount = agents?.filter(a => bindings[a.name] && !slotKeys.includes(bindings[a.name])).length ?? 0;
                  return (
                    <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px', alignItems: 'end' }}>
                        <div>
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>{t('clients.profileTitle')}</div>
                          <Combobox
                            value={selProfileId}
                            onChange={v => setProfileSel(prev => ({ ...prev, [c.name]: v }))}
                            options={[
                              { value: '', label: t('clients.profileNone') },
                              ...profiles.map(p => ({ value: p.id, label: p.name || p.id, meta: p.name ? p.id : undefined })),
                            ]}
                          />
                        </div>
                      </div>
                      {profiles.length === 0 && (
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                          {t('clients.profileEmpty')}{' '}
                          <Link to="/model-profiles" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{t('clients.profileManage')}</Link>
                        </div>
                      )}
                      {selProfileId && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ flexShrink: 0 }}>{t('clients.profileAgents')}</span>
                            <input
                              className="input"
                              value={agentFilter}
                              onChange={e => setAgentFilter(e.target.value)}
                              placeholder={t('clients.profileFilter')}
                              style={{ flex: 1, maxWidth: '260px', fontSize: '12px', padding: '3px 8px' }}
                            />
                            <span style={{ flex: 1 }} />
                            {Object.values(bindings).some(Boolean) && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ flexShrink: 0, fontSize: '11px' }}
                                title={t('clients.profileClearBindingsHint')}
                                onClick={() => setBindSel(prev => ({ ...prev, [c.name]: {} }))}
                              >
                                <Eraser size={11} />
                                <span>{t('clients.profileClearBindings')}</span>
                              </button>
                            )}
                            <Link to="/model-profiles" style={{ color: 'var(--accent)', textDecoration: 'none', flexShrink: 0 }}>{t('clients.profileManage')}</Link>
                          </div>
                          {agents === null ? (
                            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsLoading')}</div>
                          ) : agents.length === 0 ? (
                            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsEmpty')}</div>
                          ) : (() => {
                            const q = agentFilter.trim().toLowerCase();
                            const visible = agents.filter(a => !q || a.name.toLowerCase().includes(q));
                            // Primary first — few agents, biggest blast radius; subagents next;
                            // 'all' last. Inside a group bound rows lead, so the eye lands on
                            // decisions already made (amber stale bindings lead too).
                            const groups: [OpenCodeAgentView['mode'], string][] = [
                              ['primary', t('clients.profileGroupPrimary')],
                              ['subagent', t('clients.profileGroupSubagent')],
                              ['all', t('clients.profileGroupAll')],
                            ];
                            return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                              {visible.length === 0 && (
                                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsNoMatch')}</div>
                              )}
                              {groups.map(([mode, label]) => {
                                const rows = visible
                                  .filter(a => a.mode === mode)
                                  .sort((x, y) => (bindings[y.name] ? 1 : 0) - (bindings[x.name] ? 1 : 0) || x.name.localeCompare(y.name));
                                if (rows.length === 0) return null;
                                const boundN = rows.filter(a => !!bindings[a.name]).length;
                                return (
                                  <div key={mode}>
                                    <div style={{ fontSize: '10px', color: 'var(--text-dim)', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: '4px' }}>
                                      {label} · {boundN}/{rows.length}
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(430px, 1fr))', gap: '6px 18px' }}>
                                      {rows.map(a => {
                                        const bound = bindings[a.name] || '';
                                        const missing = !!bound && !slotKeys.includes(bound);
                                        return (
                                        <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                          <span style={{ width: '140px', flexShrink: 0, fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '12px' }}>{a.name}</span>
                                          {a.model && (
                                            <span
                                              title={`${t('clients.profileCurrentModel')}: ${a.model}`}
                                              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '11px', color: 'var(--text-dim)' }}
                                            >
                                              {/* de-noise: the provider prefix repeats on every row — show the tail, full id in the tooltip */}
                                              {a.model.includes('/') ? a.model.slice(a.model.lastIndexOf('/') + 1) : a.model}
                                            </span>
                                          )}
                                          <div style={{ width: '230px', flexShrink: 0 }}>
                                            <Combobox
                                              value={missing ? '' : bound}
                                              onChange={v => {
                                                const nb = { ...(bindSel[c.name] || {}), [a.name]: v };
                                                setBindSel(prev => ({ ...prev, [c.name]: nb }));
                                              }}
                                              options={[
                                                { value: '', label: t('clients.profileBindNone') },
                                                ...slotKeys.map(k => ({ value: k, label: `${k} → ${profile?.slots?.[k] ?? '?'}` })),
                                              ]}
                                              panelMinWidth={300}
                                            />
                                          </div>
                                          {missing && (
                                            <span style={{ flexShrink: 0, fontSize: '10px', color: 'var(--accent-amber)' }}>
                                              {t('clients.profileSlotMissing', { slot: bound })}
                                            </span>
                                          )}
                                        </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            );
                          })()}
                          {(keptCount > 0 || missingCount > 0) && (
                            <div style={{ fontSize: '11px', color: missingCount > 0 ? 'var(--accent-amber)' : 'var(--text-dim)' }}>
                              {t('clients.profileSlotCarry', { kept: keptCount, missing: missingCount })}
                            </div>
                          )}
                          <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>{t('clients.profileApplyHint')}</div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div style={{ display: 'flex', gap: '8px' }}>
                  {renderActionButtons(c, true)}
                  {clientSlots(c).length > 0 && (
                    <button className="btn btn-sm" onClick={() => handleResetModel(c.name)} disabled={loading} title={t('clients.reset')}>
                      <RotateCcw size={12} />
                      <span>{t('clients.reset')}</span>
                    </button>
                  )}
                </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Static row: manual hookup guide for clients the gateway can't auto-hook
              (anything speaking OpenAI or Anthropic wire protocol). Pure documentation —
              no backend adapter, no status, no action buttons. */}
          <div
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--card-border)',
              borderRadius: '10px',
              overflow: 'hidden',
            }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-expanded={otherOpen}
              onClick={toggleOther}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleOther();
                }
              }}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 18px', cursor: 'pointer', userSelect: 'none' }}
            >
              <ChevronDown
                size={16}
                color="var(--text-dim)"
                style={{ flexShrink: 0, transition: 'transform 0.15s ease', transform: otherOpen ? 'rotate(180deg)' : 'none' }}
              />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', fontWeight: 700 }}>
                <Puzzle size={18} color="var(--accent)" />
                {t('clients.otherTitle')}
              </span>
              <span style={{ flex: 1, fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('clients.otherHint')}
              </span>
              <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
                {t('clients.otherBadge')}
              </span>
            </div>

            {otherOpen && (
              <div style={{ padding: '16px 18px', borderTop: '1px solid var(--divider)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.7 }}>
                  {t('clients.otherIntro')}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  <div>{t('clients.otherStep1')}</div>
                  <div>{t('clients.otherStep2')}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
                  <div style={{ background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.otherProtoOpenai')}</div>
                    <code style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '12px', color: 'var(--text-main)', wordBreak: 'break-all' }}>
                      {`http://127.0.0.1:${gwPort}/v1`}
                    </code>
                    <div style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '11px', color: 'var(--text-dim)' }}>
                      POST /v1/chat/completions · /v1/responses · /v1/models
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.otherOpenaiAuth')}</div>
                  </div>
                  <div style={{ background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.otherProtoAnthropic')}</div>
                    <code style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '12px', color: 'var(--text-main)', wordBreak: 'break-all' }}>
                      {`http://127.0.0.1:${gwPort}`}
                    </code>
                    <div style={{ fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace", fontSize: '11px', color: 'var(--text-dim)' }}>
                      POST /v1/messages
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.otherAnthropicAuth')}</div>
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  {t('clients.otherStep3')}
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.7 }}>
                  {t('clients.otherMore')}{' '}
                  <Link to="/api-keys" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    {t('nav.apiKeys')} →
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
