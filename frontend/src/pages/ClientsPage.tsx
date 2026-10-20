import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Terminal, Check, X, RefreshCw, Undo2, ArrowUpRight, RotateCcw, ChevronDown, Puzzle, Eraser } from 'lucide-react';
import { BrandIcon } from '../components/BrandIcons';
import { Combobox } from '../components/Combobox';
import { InfoTip } from '../components/InfoTip';
import { api, type ClientStatus, type ApiKeyItem, type ModelProfileView, type OpenCodeAgentView, type ClientProfileMemoryEntry } from '../lib/api';
import { modelRefBadge } from '../lib/modelRefBadge';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';

/**
 * Slots to render for a client. An explicit `[]` means the client is
 * slot-less by design (opencode-proxy routes traffic transparently and keeps
 * opencode-native models — no model picker).
 */
const clientSlots = (c: ClientStatus): { key: string; value?: string; default?: string }[] => c.modelSlots;

/**
 * Clients whose adapter honors `extraModels` (setup writes main + extras as a
 * multi-entry models list into the hook config; getStatus echoes it back).
 * These get the shared model-list editor (none / custom / follow).
 */
const supportsExtraModels = (name: string): boolean =>
  name === 'opencode' || name === 'dsh' || name === 'pi';

/** Model-chip lists longer than this render truncated behind a "+N more" chip toggle. */
const MODEL_CHIP_LIMIT = 12;

export const ClientsPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  /** Per-client per-slot model selection ('auto' = intelligent routing default) */
  const [modelSel, setModelSel] = useState<Record<string, Record<string, string>>>({});
  /** Gateway-routable models (virtual + registered) from /v1/models */
  const [models, setModels] = useState<{ id: string; tier?: string; kind?: string }[]>([]);
  /** Gateway API keys (Claude auth token writer) */
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  /** Per-client selected API key (raw key token) — setup ALWAYS writes the
   *  picked key into the client config (client config backups cover regrets);
   *  the picker is mandatory. */
  const [apiKeySel, setApiKeySel] = useState<Record<string, string>>({});
  /** Per-client context window in tokens (claude compaction envs; default 256K) */
  const [ctxSel, setCtxSel] = useState<Record<string, string>>({});
  /** Per-client extra concrete models (model-list editors: opencode/dsh/pi) */
  const [extraSel, setExtraSel] = useState<Record<string, string[]>>({});
  /** Draft value of the extra-model add Combobox */
  const [extraDraft, setExtraDraft] = useState<Record<string, string>>({});
  /** Expanded/collapsed state of long model-chip walls (follow/custom lists). */
  const [extrasOpen, setExtrasOpen] = useState<Record<string, boolean>>({});
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
  /** Inventory fetch failed. `agents` deliberately STAYS null: the setup
   *  payload omits agent bindings whenever the inventory has not loaded, and
   *  an empty-list fallback here would let a plain Apply sweep every binding
   *  off the config. Retry re-arms the lazy-load effect. */
  const [agentsError, setAgentsError] = useState(false);
  /** Selected profile id per client ('' = no profile / un-apply) */
  const [profileSel, setProfileSel] = useState<Record<string, string>>({});
  /** Per-client agent-name → slot-key bindings (model profile application) */
  const [bindSel, setBindSel] = useState<Record<string, Record<string, string>>>({});
  /** Agent inventory filter box (binding table gets long with 25+ agents) */
  const [agentFilter, setAgentFilter] = useState('');
  // Binding-table row order: 'name' = alphabetical (default); 'suffix'/'prefix'
  // cluster rows by the agent name's last / first hyphen segment so same-kind
  // agents (java-dev, node-dev, …) sit adjacent for batch binding.
  const [agentSort, setAgentSort] = useState<'name' | 'suffix' | 'prefix'>('name');
  /** Environment-persisted form memory (config.yaml `clientProfileMemory`) */
  const [mem, setMem] = useState<Record<string, ClientProfileMemoryEntry> | null>(null);

  const ctxOptions = [
    { value: '262144', label: `256K ${t('clients.ctxDefault')}` },
    { value: '131072', label: '128K' },
    { value: '200000', label: '200K' },
    { value: '1048576', label: '1M' },
  ];
  /** Accordion: which client's config form is expanded. Starts fully collapsed —
   *  opening a form is always a deliberate user action. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** Live gateway port for the manual-endpoint guide ('' → fall back to console origin / OCR default). */
  const [port, setPort] = useState<string>('');
  const gwPort = port || window.location.port || '4000';

  const loadClients = async () => {
    try {
      const data = await api.getStatus();
      setClients(data.clients || []);
      if (data.port) setPort(String(data.port));
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
    // API-key form memory: the last-written key re-seeds the picker (resolved
    // by stable id, never the raw token). A stale id (deleted/disabled key)
    // seeds nothing — setup then demands a fresh pick.
    setApiKeySel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (next[c.name] !== undefined) continue;
        const id = mem[c.name]?.apiKeyId;
        const k = id ? apiKeys.find(x => x.id === id) : undefined;
        if (k) next[c.name] = k.key;
      }
      return next;
    });
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
        // opencode seeds from the live agent inventory instead (see the
        // agents effect below) — its draft values carry slot links, not just refs.
        if (c.name === 'opencode') continue;
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
  }, [clients, mem, profilesReady, profiles, apiKeys]);

  /** Slot-key tags behind the opencode draft — the `slot:<key>` rows only.
   *  Memory persists these (agent → slot key) so profile links survive reloads. */
  const linkTagsOf = (bind: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(
      Object.entries(bind || {})
        .filter(([, v]) => typeof v === 'string' && v.startsWith('slot:'))
        .map(([a, v]) => [a, v.slice(5)])
    );

  /** Write-through form memory into the ACTIVE environment's config.yaml
   *  (book-set scoped — switching envs switches the memory too). */
  const persistMem = (clientName: string, profile: string, bindings: Record<string, string>, modelMode?: 'none' | 'custom' | 'follow', apiKeyIdOverride?: string) => {
    const mode = modelMode ?? modeSel[clientName] ?? 'none';
    // Pure updater required: computing `next` (and firing the POST) inside the
    // setMem updater would double-invoke under StrictMode / concurrent render.
    const next = {
      ...(mem || {}),
      [clientName]: {
        profile,
        bindings,
        modelMode: mode,
        // Key memory follows the same draft-snapshot rule as modelMode;
        // `apiKeyIdOverride` covers callers that just reset/committed the form
        // (setState would not be visible to this closure yet).
        apiKeyId: apiKeyIdOverride ?? keyIdOf(apiKeySel[clientName] || ''),
      },
    };
    setMem(next);
    api.saveClientProfileMemory(next).catch(e => console.warn('profile memory save failed:', e));
  };

  /** Gateway key id behind a selected key token ('' = nothing picked) — the
   *  form memory stores the STABLE id, never the raw token. */
  const keyIdOf = (keyValue: string): string =>
    apiKeys.find(k => k.key === keyValue)?.id || '';

  /** The key object behind a client's apiKey selection (undefined = nothing picked). */
  const followKeyOf = (clientName: string): ApiKeyItem | undefined =>
    apiKeys.find(k => k.key === (apiKeySel[clientName] || ''));

  /** Effective extras for a followed key: its allowed non-virtual models. */
  const followExtrasOf = (k: ApiKeyItem): string[] =>
    (keyModels[k.id]?.models || []).filter(m => !m.virtual && m.allowed).map(m => m.id);

  /** Flip the model-list source and write it through to the form memory. */
  const setModelMode = (clientName: string, mode: 'none' | 'custom' | 'follow') => {
    setModeSel(prev => ({ ...prev, [clientName]: mode }));
    persistMem(clientName, profileSel[clientName] || '', linkTagsOf(bindSel[clientName]), mode);
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
    if (opencodeOpen && agents === null && !agentsError) {
      api.listOpencodeAgents().then(setAgents).catch(() => setAgentsError(true));
    }
  }, [opencodeOpen, agents, agentsError]);

  /** Seed opencode's agent-link draft once the inventory loads: each row
   *  mirrors the config's current agent model (router-owned values arrive
   *  stripped to the bare ref; native pins verbatim), then the profile-link
   *  echo/memory re-tags linked rows to `slot:<key>` so they keep following
   *  the profile. One draft per inventory load — after an apply the cache is
   *  dropped (setAgents(null)) and the draft entry is cleared so the fresh
   *  committed truth re-seeds; the guard keeps in-page edits alive across
   *  unrelated clients-load refreshes. */
  useEffect(() => {
    if (agents === null) return;
    const c = clients.find(x => x.name === 'opencode');
    if (!c) return;
    setBindSel(prev => {
      if (prev['opencode'] !== undefined) return prev; // in-page edits win until the next apply commit
      const tags = c.profile?.bindings || mem?.['opencode']?.bindings || {};
      const next: Record<string, string> = {};
      for (const a of agents) next[a.name] = a.model || '';
      for (const [agent, slotKey] of Object.entries(tags)) {
        if (typeof slotKey === 'string' && slotKey && agent in next) next[agent] = `slot:${slotKey}`;
      }
      return { ...prev, opencode: next };
    });
  }, [agents, clients, mem]);

  const handleToggle = async (clientName: string, action: 'setup' | 'teardown') => {
    setLoading(true);
    try {
      let extras = extraSel[clientName] || [];
      if (action === 'setup' && supportsExtraModels(clientName)) {
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
      // The picker is mandatory: without an explicit key there is nothing to
      // write — refuse rather than silently keep the previous token.
      if (action === 'setup' && !(apiKeySel[clientName] || '')) {
        toast.error(t('clients.apiKeyRequired'));
        return;
      }
      const res = await api.toggleClient(clientName, action, action === 'setup' ? {
        models: modelSel[clientName] || {},
        apiKey: apiKeySel[clientName],
        contextWindow: Number(ctxSel[clientName] || '262144'),
        extraModels: extras,
        ...opencodeAgentPayload(clientName),
      } : undefined);
      setActionNotice(res.message || 'Updated');
      // Commit-point memory: the environment remembers the selection THIS
      // setup just applied — never half-edited drafts (per-click config
      // writes would storm the hot-apply pipeline for a UI nicety).
      if (action === 'setup') {
        // Memory records what THIS setup wrote — the key's stable id, never a
        // draft pick or the raw token.
        persistMem(clientName, profileSel[clientName] || '', linkTagsOf(bindSel[clientName]), undefined, keyIdOf(apiKeySel[clientName] || ''));
      }
      // Refresh the agent inventory cache and drop the link draft so the
      // table re-seeds from the committed config (the lazy-load effect
      // refetches; the seed effect re-tags linked rows from the fresh echo).
      if (clientName === 'opencode') {
        setAgents(null);
        setBindSel(prev => {
          const { [clientName]: _dropped, ...rest } = prev;
          return rest;
        });
      }
      await loadClients();
      setTimeout(() => setActionNotice(null), 3000);
    } catch (err: any) {
      toast.error('Failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Agent-binding payload for the opencode setup call. Draft row values:
   *  - '' / 'auto'         → omitted (inherit the default model);
   *  - `slot:<key>`        → profile-linked row: tag travels via `profile.bindings`
   *                          and resolves server-side against the profile's slots;
   *  - a gateway-known ref → manual row, sent via `agentModels`;
   *  - anything else       → a native (non-router) pin echoed from the config —
   *                          never re-sent (re-sending would re-route it through
   *                          the gateway).
   * Omitted entirely until the agent inventory has loaded: a stale/absent draft
   * must never touch the agent node.
   */
  const opencodeAgentPayload = (clientName: string): { agentModels?: Record<string, string>; profile?: { id: string; bindings: Record<string, string> } } => {
    if (clientName !== 'opencode' || agents === null) return {};
    const known = new Set(models.map(m => m.id));
    const manual: Record<string, string> = {};
    const tags: Record<string, string> = {};
    for (const [agent, raw] of Object.entries(bindSel[clientName] || {})) {
      const v = (raw || '').trim();
      if (!v || v === 'auto') continue;
      if (v.startsWith('slot:')) {
        const k = v.slice(5);
        if (k) tags[agent] = k;
        continue;
      }
      if (!known.has(v)) continue;
      manual[agent] = v;
    }
    return { agentModels: manual, profile: { id: profileSel[clientName] || '', bindings: tags } };
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
    setBindSel(prev => {
      const { [clientName]: _dropped, ...rest } = prev;
      return rest;
    });
    setModeSel(prev => ({ ...prev, [clientName]: 'none' }));
    setApiKeySel(prev => {
      const { [clientName]: _dropped, ...rest } = prev;
      return rest;
    });
    // Override param: the setState above is invisible to persistMem's closure.
    persistMem(clientName, '', {}, 'none', '');
    if (clientName === 'opencode') setAgents(null); // table re-seeds from the swept config
    if (clients.find(c => c.name === clientName)?.hooked) {
      setLoading(true);
      try {
        const res = await api.toggleClient(clientName, 'setup', {
          models: cleared,
          extraModels: [],
          // Full unlink: sweep every router-owned agent override + clear the
          // profile-link echo (the reset semantics for opencode).
          ...(clientName === 'opencode' ? { agentModels: {}, profile: { id: '', bindings: {} } } : {}),
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
  };

  const modelOptions = [
    { value: 'auto', label: t('clients.modelAuto') },
    ...models
      .filter(m => m.id !== 'auto')
      .map(m => ({ value: m.id, label: m.id, ...modelRefBadge(m.kind, t) })),
  ];

  /** Slot options with an echoed-but-unlisted value (e.g. a manual foreign pin
   *  like `anthropic/claude-x`) kept visible at the top — the trigger would
   *  otherwise render empty even though a pin is active. */
  const slotOptions = (s: { key: string; value?: string }) => {
    const v = s.value;
    if (!v || v === 'auto' || modelOptions.some(o => o.value === v)) return modelOptions;
    return [{ value: v, label: v }, ...modelOptions];
  };

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
      // The virtual auto* aliases are injected fixed into every client's model
      // switcher by the adapters — hide them here (filter by catalog kind, never
      // by id prefix: registered ids may legally start with "auto").
      .filter(m => m.kind !== 'auto' && !(extraSel[clientName] || []).includes(m.id))
      .map(m => ({ value: m.id, label: m.id, ...modelRefBadge(m.kind, t) }));

  /** Chip wall for the model-list editor (follow snapshot / custom picks).
   *  Long lists truncate to the first MODEL_CHIP_LIMIT chips with a "+N more"
   *  toggle — 85 flat chips bury the rest of the card (user escalation). */
  const renderModelChips = (clientName: string, ids: string[], onRemove?: (id: string) => void) => {
    const open = !!extrasOpen[clientName];
    const truncated = !open && ids.length > MODEL_CHIP_LIMIT;
    const shown = truncated ? ids.slice(0, MODEL_CHIP_LIMIT) : ids;
    const chipStyle: React.CSSProperties = {
      padding: '3px 10px',
      borderRadius: '999px',
      border: '1px solid var(--card-border)',
      fontSize: '11px',
      fontFamily: "'JetBrains Mono', 'Noto Sans SC', 'Microsoft YaHei', monospace",
    };
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}>
        {shown.map(id => (
          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', ...chipStyle }}>
            {id}
            {onRemove && (
              <button onClick={() => onRemove(id)} style={{ display: 'inline-flex', cursor: 'pointer', color: 'var(--text-dim)', background: 'none', border: 'none', padding: 0 }}>
                <X size={10} />
              </button>
            )}
          </span>
        ))}
        {truncated && (
          <button
            type="button"
            title={t('clients.modelsShowAll', { n: ids.length })}
            onClick={() => setExtrasOpen(prev => ({ ...prev, [clientName]: true }))}
            style={{ ...chipStyle, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', background: 'var(--chip-bg)', color: 'var(--accent)' }}
          >
            +{ids.length - MODEL_CHIP_LIMIT} {t('clients.modelsMore')}
          </button>
        )}
        {!truncated && ids.length > MODEL_CHIP_LIMIT && (
          <button
            type="button"
            onClick={() => setExtrasOpen(prev => ({ ...prev, [clientName]: false }))}
            style={{ ...chipStyle, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', background: 'transparent', color: 'var(--text-dim)' }}
          >
            {t('clients.modelsCollapse')}
          </button>
        )}
      </div>
    );
  };

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
                      options={apiKeys.map(k => ({ value: k.key, label: k.name, meta: k.key.length > 12 ? `${k.key.slice(0, 8)}…${k.key.slice(-4)}` : undefined }))}
                      placeholder={t('clients.apiKeySelect')}
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
                            options={slotOptions(s)}
                            panelMinWidth={360}
                          />
                        </div>
                      ))}
                      {supportsExtraModels(c.name) && (() => {
                        const mode = modeSel[c.name] ?? 'none';
                        const follow = mode === 'follow';
                        const fk = follow ? followKeyOf(c.name) : undefined;
                        const followLoaded = !!fk && !!keyModels[fk.id];
                        const followList = fk && followLoaded ? followExtrasOf(fk) : [];
                        return (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.models')} <InfoTip text={t('clients.modelsInfo')} /></div>
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
                                  {renderModelChips(c.name, followList)}
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
                              {(extraSel[c.name] || []).length > 0 &&
                                renderModelChips(c.name, extraSel[c.name] || [], id => removeExtraModel(c.name, id))}
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
                  const bindings = bindSel[c.name] || {};
                  // Already-applied links (server echo) — used only for row
                  // ordering. Draft `bindings` must NEVER drive the sort: a row
                  // would jump to the top the instant it is picked mid-edit.
                  const appliedBindings = c.profile?.bindings || {};
                  // Row modes: `slot:<key>` = profile-linked (follows the profile —
                  // a saved profile change writes through automatically), a
                  // gateway ref = manual, '' / 'auto' = inherit the default model.
                  const linkedEntries = Object.entries(bindings).filter(
                    ([, v]) => typeof v === 'string' && v.startsWith('slot:')
                  );
                  const keptCount = profile ? linkedEntries.filter(([, v]) => !!(profile.slots || {})[v.slice(5)]).length : 0;
                  const missingCount = linkedEntries.length - keptCount;
                  // Row options: operations first — inherit / profile-slot link
                  // shortcuts (only while a profile is selected) — then the
                  // gateway model list, with a foreign native pin echoed
                  // verbatim kept visible near the top.
                  const rowOptions = (current: string) => {
                    const opts: { value: string; label: string; meta?: string; badge?: string; badgeColor?: string }[] = [
                      { value: '', label: t('clients.profileBindNone') },
                    ];
                    if (profile) {
                      for (const [k, ref] of Object.entries(profile.slots || {})) {
                        opts.push({
                          value: `slot:${k}`,
                          label: t('clients.profileSlotLabel', { slot: k }),
                          // Same right-side chip language as the auto* entries —
                          // emerald marks the profile-linked kind.
                          badge: t('modelRef.kindProfileSlot'),
                          badgeColor: 'var(--accent-emerald)',
                          meta: ref,
                        });
                      }
                    }
                    opts.push(...modelOptions);
                    if (current && !opts.some(o => o.value === current)) opts.splice(1, 0, { value: current, label: current });
                    return opts;
                  };
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
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
                          {t('clients.profileLinkedHint', { name: profiles.find(p => p.id === selProfileId)?.name || selProfileId })}
                        </div>
                      )}
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
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }} title={t('clients.profileSortHint')}>
                              <span style={{ fontSize: '11px', color: 'var(--text-dim)', marginRight: '2px' }}>{t('clients.profileSortLabel')}</span>
                              {([
                                ['name', t('clients.profileSortName')],
                                ['suffix', t('clients.profileSortSuffix')],
                                ['prefix', t('clients.profileSortPrefix')],
                              ] as const).map(([k, label]) => (
                                <button
                                  key={k}
                                  type="button"
                                  className="btn btn-sm"
                                  style={{ fontSize: '11px', padding: '3px 8px', ...(agentSort === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}) }}
                                  onClick={() => setAgentSort(k)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
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
                            agentsError ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--accent-amber)' }}>
                                <span>{t('clients.profileAgentsError')}</span>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  style={{ fontSize: '11px' }}
                                  onClick={() => setAgentsError(false)}
                                >
                                  {t('clients.profileAgentsRetry')}
                                </button>
                              </div>
                            ) : (
                              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsLoading')}</div>
                            )
                          ) : agents.length === 0 ? (
                            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsEmpty')}</div>
                          ) : (() => {
                            const q = agentFilter.trim().toLowerCase();
                            const visible = agents.filter(a => !q || a.name.toLowerCase().includes(q));
                            // Primary first — few agents, biggest blast radius; subagents next;
                            // 'all' last. Inside a group already-applied bound rows lead, so the
                            // eye lands on decisions already made — under the default 'name' sort;
                            // with suffix/prefix clustering the cluster key leads instead and
                            // applied-first drops to the secondary tiebreak. In-page picks keep
                            // the order stable and only reshuffle after the next apply refresh.
                            const groups: [OpenCodeAgentView['mode'], string][] = [
                              ['primary', t('clients.profileGroupPrimary')],
                              ['subagent', t('clients.profileGroupSubagent')],
                              ['all', t('clients.profileGroupAll')],
                            ];
                            // Name clustering key: 'suffix' = segment after the last '-'
                            // (java-dev / node-dev cluster together), 'prefix' = segment
                            // before the first '-'. Names without a hyphen use the full name.
                            const nameKey = (a: OpenCodeAgentView): string => {
                              const n = a.name;
                              if (agentSort === 'prefix') {
                                const i = n.indexOf('-');
                                return i === -1 ? n : n.slice(0, i);
                              }
                              const i = n.lastIndexOf('-');
                              return i === -1 ? n : n.slice(i + 1);
                            };
                            return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                              {visible.length === 0 && (
                                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>{t('clients.profileAgentsNoMatch')}</div>
                              )}
                              {groups.map(([mode, label]) => {
                                const rows = visible
                                  .filter(a => a.mode === mode)
                                  .sort((x, y) => (agentSort !== 'name' ? nameKey(x).localeCompare(nameKey(y)) : 0)
                                    || (appliedBindings[y.name] ? 1 : 0) - (appliedBindings[x.name] ? 1 : 0)
                                    || x.name.localeCompare(y.name));
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
                                        const linked = bound.startsWith('slot:');
                                        const missing = linked && !(profile?.slots || {})[bound.slice(5)];
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
                                              value={bound}
                                              onChange={v => {
                                                const nb = { ...(bindSel[c.name] || {}), [a.name]: v };
                                                setBindSel(prev => ({ ...prev, [c.name]: nb }));
                                              }}
                                              options={rowOptions(bound)}
                                              panelMinWidth={300}
                                            />
                                          </div>
                                          {missing && (
                                            <span style={{ flexShrink: 0, fontSize: '10px', color: 'var(--accent-amber)' }}>
                                              {t('clients.profileSlotMissing', { slot: bound.slice(5) })}
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
