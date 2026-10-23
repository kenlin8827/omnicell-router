import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Terminal, Check, X, RefreshCw, Undo2, ArrowUpRight, RotateCcw, ChevronDown, Puzzle, Eraser, Sparkles } from 'lucide-react';
import { BrandIcon } from '../components/BrandIcons';
import { Combobox } from '../components/Combobox';
import { InfoTip } from '../components/InfoTip';
import { ProfileLinkTable } from '../components/ProfileLinkTable';
import { SmartAssignDialog, type SmartAssignTarget, type SmartAssignCandidate } from '../components/SmartAssignDialog';
import { api, type ClientStatus, type ApiKeyItem, type ModelProfileView, type OpenCodeAgentView, type ClientProfileMemoryEntry } from '../lib/api';
import { modelRefBadge } from '../lib/modelRefBadge';
import { sortModelOptions } from '../lib/model-options';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';

import { FONT_MONO } from '../lib/fonts';
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
  const [models, setModels] = useState<{ id: string; tier?: string; kind?: string; members?: number }[]>([]);
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
  /** Profiles fetch settled — the seed effect must not compare memory against a
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
  /** Agent/role link table visibility (opencode, pi). OFF = the form declares
   *  "not configuring subagents": the table hides and the setup payload omits
   *  the agent bindings entirely (no sweep — existing overrides survive).
   *  Seeded ON iff links exist (echo or memory); persisted via memory. */
  const [linksOn, setLinksOn] = useState<Record<string, boolean>>({});
  /** Environment-persisted form memory (config.yaml `clientProfileMemory`) */
  const [mem, setMem] = useState<Record<string, ClientProfileMemoryEntry> | null>(null);
  /** Smart-assign dialog target: client name + the sub-agent rows built from
   *  the CURRENT draft state, the candidate list, and whether assignments are
   *  profile slot links (follows the page's current profile selection). */
  const [smartFor, setSmartFor] = useState<{
    name: string;
    targets: SmartAssignTarget[];
    /** Profile-mode only: the linked profile's slot keys (+ model note). */
    candidates?: SmartAssignCandidate[];
    profileMode: boolean;
    /** No-profile candidate basis: gateway models, permission-scoped to the
     *  client's selected API key when one is picked. */
    basis: { id: string; kind?: string; members?: number }[];
    scopeHint: string;
  } | null>(null);

  const ctxOptions = [
    { value: '262144', label: `256K ${t('clients.ctxDefault')}` },
    { value: '131072', label: '128K' },
    { value: '200000', label: '200K' },
    { value: '1048576', label: '1M' },
  ];
  /** Accordion: the single client whose config form is expanded ('other' = the
   *  static manual-setup row, null = all collapsed). Single-open by design — the
   *  forms are tall, and every draft lives in page-level state keyed by client
   *  name, so collapsing never loses edits and opening a form is always a
   *  deliberate user action. */
  const [expanded, setExpanded] = useState<string | null>(null);
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
            // Profile-link echo re-tags non-main slots as `slot:<key>` drafts —
            // the picker shows the link entry instead of the resolved ref.
            const tags = c.profile?.bindings || {};
            for (const s of clientSlots(c)) {
              slots[s.key] = s.key !== 'main' && tags[s.key] ? `slot:${tags[s.key]}` : (s.value || s.default || 'auto');
            }
            next[c.name] = slots;
          }
        }
        return next;
      });
      // pi role rows live in the same link-table draft shape as opencode's:
      // seeded from the slot echo (bare ref / native pin verbatim), then the
      // profile-link echo re-tags linked roles to `slot:<key>`.
      setBindSel(prev => {
        const next = { ...prev };
        for (const c of data.clients || []) {
          if (c.name !== 'pi' || next[c.name] !== undefined) continue;
          const tags = c.profile?.bindings || {};
          const rows: Record<string, string> = {};
          for (const s of clientSlots(c)) {
            if (s.key === 'main') continue;
            rows[s.key] = tags[s.key] ? `slot:${tags[s.key]}` : (s.value || '');
          }
          next[c.name] = rows;
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
    setLinksOn(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (c.name !== 'opencode' && c.name !== 'pi') continue;
        if (next[c.name] !== undefined) continue;
        // Persisted choice wins; absent → ON iff links already exist (echo or
        // memory) — a linked client must not wake up looking unconfigured,
        // a fresh one stays collapsed.
        const memEntry = mem[c.name];
        if (memEntry?.linksOn !== undefined) {
          next[c.name] = memEntry.linksOn;
          continue;
        }
        const tagCount = Object.keys(c.profile?.bindings || memEntry?.bindings || {}).length;
        next[c.name] = tagCount > 0;
      }
      return next;
    });
    setBindSel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        // opencode seeds from the live agent inventory and pi from its role
        // slots (see loadClients) — their draft values carry slot links, not
        // just refs.
        if (c.name === 'opencode' || c.name === 'pi') continue;
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

  /** Slot-key tags behind a client's drafts — the `slot:<key>` values only.
   *  opencode keeps them in the agent-table draft (bindSel); pi keeps them in
   *  the role-slot drafts (modelSel). Memory persists tags so links survive
   *  reloads. */
  const linkTagsOf = (draft: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(
      Object.entries(draft || {})
        .filter(([k, v]) => k !== 'main' && typeof v === 'string' && v.startsWith('slot:'))
        .map(([a, v]) => [a, v.slice(5)])
    );

  /** Write-through form memory into the ACTIVE environment's config.yaml
   *  (book-set scoped — switching envs switches the memory too).
   *  `linksOnOverride` covers the toggle handler: the setState above it is
   *  invisible to this closure (same rule as apiKeyIdOverride). */
  const persistMem = (clientName: string, profile: string, bindings: Record<string, string>, modelMode?: 'none' | 'custom' | 'follow', apiKeyIdOverride?: string, linksOnOverride?: boolean) => {
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
        linksOn: linksOnOverride ?? linksOn[clientName],
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
  const opencodeOpen = expanded === 'opencode';
  useEffect(() => {
    if (opencodeOpen && agents === null && !agentsError && linksOn['opencode'] !== false) {
      api.listOpencodeAgents().then(setAgents).catch(() => setAgentsError(true));
    }
  }, [opencodeOpen, agents, agentsError, linksOn]);

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
      const piPayload = piLinkPayload(clientName);
      const res = await api.toggleClient(clientName, action, action === 'setup' ? {
        models: piPayload.models,
        apiKey: apiKeySel[clientName],
        contextWindow: Number(ctxSel[clientName] || '262144'),
        extraModels: extras,
        ...(piPayload.agentModels ? { agentModels: piPayload.agentModels } : {}),
        profile: piPayload.profile,
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
      if (clientName === 'opencode') setAgents(null);
      if (clientName === 'opencode' || clientName === 'pi') {
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
    // agents === null: inventory not loaded — a stale/absent draft must never
    // touch the agent node. Switch OFF: the form declares "not configuring" —
    // the payload is omitted entirely (no sweep; existing overrides survive).
    if (clientName !== 'opencode' || agents === null || linksOn[clientName] === false) return {};
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
    persistMem(clientName, '', {}, 'none', '', false);
    setLinksOn(prev => ({ ...prev, [clientName]: false }));
    if (clientName === 'opencode') setAgents(null); // table re-seeds from the swept config
    if (clients.find(c => c.name === clientName)?.hooked) {
      setLoading(true);
      try {
        const res = await api.toggleClient(clientName, 'setup', {
          models: cleared,
          extraModels: [],
          // Full unlink: sweep every router-owned agent override + clear the
          // profile-link echo (the reset semantics for link-capable clients).
          ...(clientName === 'opencode' ? { agentModels: {} } : {}),
          ...(clientName === 'opencode' || clientName === 'pi' ? { profile: { id: '', bindings: {} } } : {}),
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

  const modelOptions = sortModelOptions(models
    .map(m => ({
      value: m.id,
      label: m.id === 'auto' ? t('clients.modelAuto') : m.id,
      kind: m.kind,
      meta: m.kind === 'combo' && m.members !== undefined
        ? t('models.memberCount', { n: m.members })
        : undefined,
      ...modelRefBadge(m.kind, t),
    })));

  /** Slot options with an echoed-but-unlisted value (e.g. a manual foreign pin
   *  like `anthropic/claude-x`) kept visible at the top — the trigger would
   *  otherwise render empty even though a pin is active. */
  const slotOptions = (s: { key: string; value?: string }) => {
    const v = s.value;
    if (!v || v === 'auto' || modelOptions.some(o => o.value === v)) return modelOptions;
    return [{ value: v, label: v }, ...modelOptions];
  };

  /** pi payload: main stays a plain model pick; the role-link table's drafts
   *  split into manual refs (agentModels) and profile-link tags (`slot:<key>`,
   *  resolved server-side). Native pins echoed verbatim are never re-sent.
   *  Other clients pass their slot map through unchanged. */
  const piLinkPayload = (clientName: string): { models: Record<string, string>; agentModels?: Record<string, string>; profile?: { id: string; bindings: Record<string, string> } } => {
    if (clientName !== 'pi') return { models: modelSel[clientName] || {} };
    // Switch OFF = "not configuring roles": main still applies, the role
    // payload is omitted entirely (no sweep; existing overrides survive).
    if (linksOn[clientName] === false) return { models: { main: modelSel[clientName]?.main || 'auto' } };
    const known = new Set(models.map(m => m.id));
    const manual: Record<string, string> = {};
    const tags: Record<string, string> = {};
    for (const [role, raw] of Object.entries(bindSel[clientName] || {})) {
      const v = (raw || '').trim();
      if (!v || v === 'auto') continue;
      if (v.startsWith('slot:')) {
        const k = v.slice(5);
        if (k) tags[role] = k;
        continue;
      }
      if (!known.has(v)) continue;
      manual[role] = v;
    }
    return {
      models: { main: modelSel[clientName]?.main || 'auto' },
      agentModels: manual,
      profile: { id: profileSel[clientName] || '', bindings: tags },
    };
  };

  /** Slot/agent rows the smart-assign decider fills — built from the CURRENT
   *  draft state (never the saved config). Main/primary rows are included in
   *  plain mode (the decider assigns a direct model ref verbatim). In profile
   *  mode pi's `main` is EXCLUDED: main is never a profile link (see
   *  `linkTagsOf`/`piLinkPayload`), and a `slot:<key>` wrap would write an
   *  illegal draft into pi's main model pick. Candidate semantics follow the
   *  page's CURRENT profile selection: a picked profile means assignments are
   *  its SLOT KEYS (linked as `slot:<key>` drafts, candidates annotated with
   *  the slot's model); no profile means direct gateway model refs. */
  const openSmartAssign = async (c: ClientStatus) => {
    const profileId = profileSel[c.name] || '';
    const profile = profiles.find(p => p.id === profileId);
    const profileMode = !!profile;
    let targets: SmartAssignTarget[];
    if (c.name === 'pi') {
      targets = clientSlots(c)
        // Profile mode: skip `main` — it stays a plain model pick, never a
        // profile-link tag (`slot:<key>` would corrupt pi's primary model).
        .filter(s => !profileMode || s.key !== 'main')
        .map(s => ({
          key: s.key,
          label: slotLabels[s.key] || s.key,
          current: s.key === 'main' ? modelSel[c.name]?.main : bindSel[c.name]?.[s.key],
        }));
    } else if (c.name === 'opencode') {
      targets = (agents || []).map(a => ({ key: a.name, label: a.name, role: a.mode, current: bindSel[c.name]?.[a.name] }));
    } else {
      targets = clientSlots(c).map(s => ({ key: s.key, label: slotLabels[s.key] || s.key, current: modelSel[c.name]?.[s.key] }));
    }
    if (targets.length === 0) return;
    if (profileMode && Object.keys(profile!.slots || {}).length === 0) return;

    // Permission scoping: the client's traffic will carry its selected API
    // key, so plain-mode candidates only make sense within that key's model
    // access. No key picked yet = show everything but say so (the setup will
    // demand a key before anything is written).
    let basis = models;
    let scopeHint = t('clients.smartScopeNone');
    const key = followKeyOf(c.name);
    if (key) {
      const view = keyModels[key.id] || (await api.getKeyModels(key.id).catch(() => null));
      if (view) {
        setKeyModels(prev => (prev[key.id] ? prev : { ...prev, [key.id]: view }));
        const allowed = new Set(view.models.filter(m => m.allowed).map(m => m.id));
        basis = models.filter(m => allowed.has(m.id));
        scopeHint = t('clients.smartScopeKey');
      }
    }
    if (!profileMode && basis.length === 0) {
      toast.error(t('clients.smartScopeEmpty'));
      return;
    }
    setSmartFor({
      name: c.name,
      targets,
      candidates: profileMode ? Object.entries(profile!.slots || {}).map(([k, ref]) => ({ id: k, note: ref })) : undefined,
      profileMode,
      basis,
      scopeHint,
    });
  };

  /** Write decider assignments back into the page's DRAFT state (never
   *  config). pi's `main` is a slot pick (modelSel), not a link-table row —
   *  split it off; everything else goes to the link-table draft. Profile mode
   *  wraps each value as a `slot:<key>` link tag; plain mode writes the model
   *  ref verbatim. `main` never arrives wrapped: profile mode excludes it
   *  from the targets, and plain mode assigns a bare model ref. */
  const applySmartAssignments = (clientName: string, assignments: Record<string, string>, profileMode: boolean) => {
    const wrap = (v: string) => (profileMode ? `slot:${v}` : v);
    const apply = (draft: Record<string, string>) =>
      Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, wrap(v)]));
    if (clientName === 'pi') {
      const { main, ...roles } = assignments;
      if (main) setModelSel(prev => ({ ...prev, [clientName]: { ...(prev[clientName] || {}), main: wrap(main) } }));
      if (Object.keys(roles).length > 0) {
        setBindSel(prev => ({ ...prev, [clientName]: { ...(prev[clientName] || {}), ...apply(roles) } }));
        setLinksOn(prev => ({ ...prev, [clientName]: true }));
      }
      return;
    }
    if (clientName === 'opencode') {
      setBindSel(prev => ({ ...prev, [clientName]: { ...(prev[clientName] || {}), ...apply(assignments) } }));
      setLinksOn(prev => ({ ...prev, [clientName]: true }));
      return;
    }
    setModelSel(prev => ({ ...prev, [clientName]: { ...(prev[clientName] || {}), ...apply(assignments) } }));
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

  /** Clear the whole custom model draft in one click (chips are per-model; bulk reset needs its own affordance). */
  const clearExtraModels = (clientName: string) =>
    setExtraSel(prev => ({ ...prev, [clientName]: [] }));

  /** Chip wall for the model-list editor (follow snapshot / custom picks).
   *  Long lists truncate to the first MODEL_CHIP_LIMIT chips with a "+N more"
   *  toggle — 85 flat chips bury the rest of the card (user escalation). */
  const renderModelChips = (clientName: string, ids: string[], onRemove?: (id: string) => void, trailing?: React.ReactNode) => {
    const open = !!extrasOpen[clientName];
    const truncated = !open && ids.length > MODEL_CHIP_LIMIT;
    const shown = truncated ? ids.slice(0, MODEL_CHIP_LIMIT) : ids;
    const chipStyle: React.CSSProperties = {
      padding: '3px 10px',
      borderRadius: '999px',
      border: '1px solid var(--card-border)',
      fontSize: '11px',
      fontFamily: FONT_MONO,
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
        {trailing}
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
  const otherOpen = expanded === 'other';
  const toggleOther = () => setExpanded(prev => (prev === 'other' ? null : 'other'));

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
            const open = expanded === c.name;
            const toggle = () => setExpanded(prev => (prev === c.name ? null : c.name));
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
                    style={{ flex: 1, fontFamily: FONT_MONO, fontSize: '11px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
                      <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: 'var(--text-muted)', wordBreak: 'break-all', marginTop: '3px' }}>
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
                {clientSlots(c).filter(s => c.name !== 'pi' || s.key === 'main').map(s => (
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
                {c.name === 'pi' && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <ProfileLinkTable
                      rows={clientSlots(c).filter(s => s.key !== 'main').map(s => ({ name: s.key, current: s.value }))}
                      emptyText={t('clients.profileAgentsEmpty')}
                      profileId={profileSel[c.name] || ''}
                      profiles={profiles}
                      onProfileChange={v => setProfileSel(prev => ({ ...prev, [c.name]: v }))}
                      headerAction={
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ flexShrink: 0, fontSize: '11px' }}
                          onClick={() => openSmartAssign(c)}
                          disabled={loading}
                          title={t('clients.smartBtn')}
                        >
                          <Sparkles size={11} />
                          <span>{t('clients.smartBtn')}</span>
                        </button>
                      }
                      gatewayOptions={modelOptions}
                      drafts={bindSel[c.name] || {}}
                      appliedTags={c.profile?.bindings || {}}
                      onDraft={(name, v) => setBindSel(prev => ({ ...prev, [c.name]: { ...(prev[c.name] || {}), [name]: v } }))}
                      onClear={() => setBindSel(prev => ({ ...prev, [c.name]: {} }))}
                      hint={t('clients.profileApplyHintPi')}
                      label={t('clients.profileRowsLabel')}
                      on={linksOn[c.name]}
                      onToggle={v => {
                        setLinksOn(prev => ({ ...prev, [c.name]: v }));
                        persistMem(c.name, profileSel[c.name] || '', linkTagsOf(bindSel[c.name]), undefined, undefined, v);
                      }}
                      linkedCount={Object.keys(linkTagsOf(bindSel[c.name])).length}
                    />
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '8px' }}>
                      {t('clients.piMetaHint')}
                    </div>
                  </div>
                )}
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
                                renderModelChips(
                                  c.name,
                                  extraSel[c.name] || [],
                                  id => removeExtraModel(c.name, id),
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    style={{ fontSize: '11px' }}
                                    onClick={() => clearExtraModels(c.name)}
                                    disabled={loading}
                                    title={t('clients.modelsClearHint')}
                                  >
                                    <Eraser size={11} />
                                    <span>{t('clients.modelsClear')}</span>
                                  </button>
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
                          {c.name === 'pi' && (
                            <div style={{ fontSize: '11px', color: 'var(--text-dim)', lineHeight: 1.6, marginTop: '8px' }}>
                              {t('clients.piMetaHint')}
                            </div>
                          )}
                        </div>
                        );
                      })()}
                    </div>

                {c.name === 'opencode' && (
                  <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px' }}>
                    <ProfileLinkTable
                      rows={(agents || []).map(a => ({ name: a.name, mode: a.mode, current: a.model }))}
                      loading={agents === null}
                      error={agentsError}
                      onRetry={() => setAgentsError(false)}
                      emptyText={t('clients.profileAgentsEmpty')}
                      profileId={profileSel[c.name] || ''}
                      profiles={profiles}
                      onProfileChange={v => setProfileSel(prev => ({ ...prev, [c.name]: v }))}
                      headerAction={
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ flexShrink: 0, fontSize: '11px' }}
                          onClick={() => openSmartAssign(c)}
                          disabled={loading}
                          title={t('clients.smartBtn')}
                        >
                          <Sparkles size={11} />
                          <span>{t('clients.smartBtn')}</span>
                        </button>
                      }
                      gatewayOptions={modelOptions}
                      drafts={bindSel[c.name] || {}}
                      appliedTags={c.profile?.bindings || {}}
                      onDraft={(name, v) => setBindSel(prev => ({ ...prev, [c.name]: { ...(prev[c.name] || {}), [name]: v } }))}
                      onClear={() => setBindSel(prev => ({ ...prev, [c.name]: {} }))}
                      hint={t('clients.profileApplyHint')}
                      label={t('clients.profileRowsLabel')}
                      on={linksOn[c.name]}
                      onToggle={v => {
                        setLinksOn(prev => ({ ...prev, [c.name]: v }));
                        persistMem(c.name, profileSel[c.name] || '', linkTagsOf(bindSel[c.name]), undefined, undefined, v);
                      }}
                      linkedCount={Object.keys(linkTagsOf(bindSel[c.name])).length}
                      showSort
                    />
                  </div>
                )}

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

          {smartFor && (
            <SmartAssignDialog
              clientName={smartFor.name}
              targets={smartFor.targets}
              candidates={smartFor.candidates}
              profileMode={smartFor.profileMode}
              models={smartFor.basis}
              scopeHint={smartFor.scopeHint}
              onClose={() => setSmartFor(null)}
              onApply={a => applySmartAssignments(smartFor.name, a, smartFor.profileMode)}
            />
          )}

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
                    <code style={{ fontFamily: FONT_MONO, fontSize: '12px', color: 'var(--text-main)', wordBreak: 'break-all' }}>
                      {`http://127.0.0.1:${gwPort}/v1`}
                    </code>
                    <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: 'var(--text-dim)' }}>
                      POST /v1/chat/completions · /v1/responses · /v1/models
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.otherOpenaiAuth')}</div>
                  </div>
                  <div style={{ background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{t('clients.otherProtoAnthropic')}</div>
                    <code style={{ fontFamily: FONT_MONO, fontSize: '12px', color: 'var(--text-main)', wordBreak: 'break-all' }}>
                      {`http://127.0.0.1:${gwPort}`}
                    </code>
                    <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: 'var(--text-dim)' }}>
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
