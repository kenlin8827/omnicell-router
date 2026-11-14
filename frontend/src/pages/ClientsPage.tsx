import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Terminal, Check, X, RefreshCw, Undo2, ArrowUpRight, RotateCcw, ChevronDown, Eraser, Sparkles, Copy, Activity, Search, AlertTriangle } from 'lucide-react';
import { BrandIcon } from '../components/BrandIcons';
import { Combobox } from '../components/Combobox';
import { SegGroup } from '../components/SegGroup';
import { InfoTip } from '../components/InfoTip';
import { ProfileLinkTable } from '../components/ProfileLinkTable';
import { SmartAssignDialog, type SmartAssignTarget, type SmartAssignCandidate } from '../components/SmartAssignDialog';
import { PluginConfigDrawer } from '../components/PluginConfigDrawer';
import { api, opencodeApi, type ClientStatus, type ClientArtifact, type ApiKeyItem, type ModelProfileView, type OpenCodeAgentView, type ClientProfileMemoryEntry, type PluginViewInfo, type CaTrustResponse } from '../lib/api';
import { modelRefBadge } from '../lib/modelRefBadge';
import { gatewayBaseUrl } from '../lib/gateway-url';
import { gatewayModeValue, gatewayVocabulary, parseGatewayCfg, type GatewayCfgDraft } from '../lib/plugin-config';
import { sortModelOptions } from '../lib/model-options';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { FONT_MONO } from '../lib/fonts';
import { copyToClipboard } from '../lib/clipboard';
/**
 * Slots to render for a client. An explicit `[]` means the client is
 * slot-less by design (proxy hooks route traffic transparently and keep the
 * client's native models — no model picker).
 */
const clientSlots = (c: ClientStatus | undefined): { key: string; value?: string; default?: string; description?: string }[] => c?.modelSlots ?? [];

/**
 * Clients whose adapter honors `extraModels` (setup writes main + extras as a
 * multi-entry models list into the hook config; getStatus echoes it back).
 * These get the shared model-list editor (none / custom / follow).
 */
const supportsExtraModels = (name: string): boolean =>
  name === 'opencode' || name === 'dsh' || name === 'pi' || name === 'omp' || name === 'grok' || name === 'kimi' || name === 'openclaw' || name === 'workbuddy';

/** Backend machine reasonCodes (ClientActionResult) → i18n keys (per-adapter failure modes). */
const CLIENT_REASON_KEY: Record<string, string> = {
  forwardProxyDisabled: 'clients.proxyErrForwardProxyDisabled',
  forwardProxyCaMissing: 'clients.proxyErrCaMissing',
  serviceProbeFailed: 'clients.proxyErrServiceProbe',
  serviceSetEnvFailed: 'clients.proxyErrServiceSetEnv',
  serviceStartFailed: 'clients.proxyErrServiceStart',
  notActive: 'clients.proxyErrNotActive',
  forward_proxy_disabled: 'clients.cursorErrForwardProxyDisabled',
  forward_proxy_ca_missing: 'clients.cursorErrCaMissing',
  cursor_not_found: 'clients.cursorErrNotFound',
  qoder_not_found: 'clients.qoderErrNotFound',
  not_active: 'clients.clientErrNotActive',
  takeover_lost: 'clients.clientErrTakeoverLost',
  proxy_credential_required: 'clients.gatewayKeyRequired',
  remove_failed: 'clients.cursorErrRemoveFailed',
};

type TFn = (key: string, params?: Record<string, string | number>) => string;

/** Localize a client setup/teardown failure: a mapped reasonCode wins,
 * anything else (other adapters, unknown codes) falls back to the raw
 * server message — loud, never swallowed. */
const clientActionErrorText = (err: unknown, t: TFn): string => {
  const e = err as { reasonCode?: string; params?: Record<string, string>; message?: string };
  const key = e?.reasonCode ? CLIENT_REASON_KEY[e.reasonCode] : undefined;
  if (key) return t(key, e.params ?? {});
  return t('common.failed') + (e?.message ?? String(err));
};

/**
 * Clients whose non-main slots are ROLE rows (pi's subagent roles, omp's
 * modelRoles): main lives in modelSel, roles in the link-table draft
 * (bindSel) with `slot:<key>` profile tags — see piLinkPayload/applySmartAssignments.
 */
const isRoleTableClient = (name: string): boolean => name === 'pi' || name === 'omp';

/** Model-chip lists longer than this render truncated behind a "+N more" chip toggle. */
const MODEL_CHIP_LIMIT = 12;

/** The gateway's virtual tier namespace (bare alias + tier aliases), canonical order —
 *  mirrors backend VIRTUAL_AUTO_IDS (cli/types.ts). */
const VIRTUAL_TIER_IDS = ['auto', 'lite', 'plus', 'pro', 'ultra'];

/** Adapter default virtual block when a custom-mode setup omits `virtualModels`:
 *  opencode/dsh/pi/omp/kimi/workbuddy/openclaw inject the full block, grok
 *  injects none (its own historical default). Keep in sync with the adapters. */
const virtualDefaultFor = (clientName: string): string[] =>
  clientName === 'grok' ? [] : [...VIRTUAL_TIER_IDS];

/** A gateway plugin's model surface lives in its plugin config but is edited
 *  HERE (client card), not on the Plugins page: the model list is part of "how
 *  this client connects", while the plugin page keeps protocol/runtime
 *  settings. The draft shape and its schema-derived vocabulary live in
 *  `lib/plugin-config`: the card speaks each gateway's DECLARED spelling, never
 *  one gateway's. */

/** Same model ids, order-insensitive: the chip wall is an unordered set. */
function sameModelSelection(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Proxy clients whose model surface is owned by a client-gateway plugin. */
const GATEWAY_PLUGIN_BY_CLIENT: Record<string, string> = {
  'cursor-proxy': 'cursor-gateway',
  'qoder-proxy': 'qoder-gateway',
  // NO jetbrains-gateway entry: that plugin is a relay-only observer with no
  // model catalog, and this map drives the catalog editor — pointing IDEA at it
  // would render an empty models form for a plugin that does not own one.
};

/**
 * The `ocr` launch verb per launcher client — the actionable start command
 * once a launcher is ready. Declared once here (not in i18n): the command IS
 * the product surface and must never drift from the CLI's passthrough verbs
 * (`ocr cursor` / `ocr cursor-agent` / `ocr qoder` / `ocr qoder-cli`).
 */
const LAUNCH_COMMANDS: Record<string, { primary: string; alt: string }> = {
  'cursor-proxy': { primary: 'ocr cursor', alt: 'ocr cursor-agent' },
  'qoder-proxy': { primary: 'ocr qoder', alt: 'ocr qoder-cli' },
};

const CLIENT_BY_GATEWAY_PLUGIN: Record<string, string> = Object.fromEntries(
  Object.entries(GATEWAY_PLUGIN_BY_CLIENT).map(([client, plugin]) => [plugin, client]),
);

interface GatewayPluginState {
  installed: boolean;
  loaded: boolean;
  disabled: boolean;
  /** Full plugin view for the in-place settings drawer (name/version). */
  view: PluginViewInfo | null;
}

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
  /** Clients whose key picker is flagged by a refused setup: red trigger + a
   *  scroll-to/focus. Cleared when a key is picked, another action starts, the
   *  card folds back or the operator leaves the tab — never sticky. */
  const [keyError, setKeyError] = useState<Record<string, true>>({});
  const clearKeyError = (clientName: string) =>
    setKeyError((prev) => {
      if (!(clientName in prev)) return prev;
      const { [clientName]: _dropped, ...rest } = prev;
      return rest;
    });
  /** DOM handles of the key pickers, keyed by client name — the validation
   *  feedback scrolls the refused card's picker into view and focuses it. */
  const keyPickerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  /** Per-client context window in tokens (claude compaction envs; default 256K) */
  const [ctxSel, setCtxSel] = useState<Record<string, string>>({});
  /** Gateway-backed clients are plugin-driven, not config-writing adapters:
   *  each model surface lives in its plugin config but is edited on THIS client
   *  card. Keyed by PLUGIN id (the config owner). */
  const [gatewayCfg, setGatewayCfg] = useState<Record<string, GatewayCfgDraft>>({});
  const [gatewayCfgBusy, setGatewayCfgBusy] = useState<Record<string, boolean>>({});
  /** Post-save hint per plugin id: the catalog is live in the gateway already,
   *  but the CLIENT caches its own model list — point at an app restart instead
   *  of a hook teardown, which never refreshes that list. */
  const [gatewaySavedNotice, setGatewaySavedNotice] = useState<Record<string, boolean>>({});
  /** Loaded/disabled state per gateway plugin. Without it the proxy can still be
   *  installed, but the client sees no OCR catalog: the card must say so instead
   *  of advertising a model list that does not exist. */
  const [gatewayPlugins, setGatewayPlugins] = useState<Record<string, GatewayPluginState>>({});
  /** In-place plugin settings drawer. It edits only the protocol/runtime keys —
   *  the model surface stays in the card editor — so opening it never navigates
   *  away or drops this card's draft. */
  const [advancedPlugin, setAdvancedPlugin] = useState<PluginViewInfo | null>(null);
  /** Per-client extra concrete models (model-list editors: opencode/dsh/pi) */
  const [extraSel, setExtraSel] = useState<Record<string, string[]>>({});
  /** Per-client custom virtual-tier draft (custom mode): the explicit set the
   *  switcher gets. Undefined = untouched draft — the setup payload omits
   *  `virtualModels` and the adapter injects its own default block. */
  const [virtualSel, setVirtualSel] = useState<Record<string, string[] | undefined>>({});
  /** Expanded/collapsed state of long model-chip walls (follow/custom lists). */
  const [extrasOpen, setExtrasOpen] = useState<Record<string, boolean>>({});
  /** Family cards: which nested product panel is expanded, keyed `client:product`.
   *  Nested panels start collapsed — the row above already carries each
   *  product's status badge, so opening one is a deliberate "show me the files".
   *  Deliberately NOT exclusive (unlike the card-level accordion): the body is a
   *  few status lines, and the job is comparing file/CA state across the family's
   *  IDEs. The card level stays single-open because the forms are tall. */
  const [openProducts, setOpenProducts] = useState<Record<string, boolean>>({});
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
  /** Environment-persisted form memory (config.yaml `clientProfileMemory`) —
   *  the full snapshot written at each setup commit (see rememberDraft). */
  const [mem, setMem] = useState<Record<string, ClientProfileMemoryEntry> | null>(null);
  /** Synchronous mirror of `mem`: consecutive commit writes before a
   *  re-render must build on each other, not on a stale snapshot. */
  const memRef = useRef<Record<string, ClientProfileMemoryEntry> | null>(null);
  /** Clients whose extras draft was already hydrated from memory — the
   *  hydration must happen exactly once, never on late effect re-runs. */
  const extrasSeeded = useRef<Set<string>>(new Set());
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
    basis: { id: string; kind?: string; members?: number; wire?: string }[];
    scopeHint: string;
  } | null>(null);

  const ctxOptions = [
    { value: '262144', label: `256K ${t('clients.ctxDefault')}` },
    { value: '131072', label: '128K' },
    { value: '200000', label: '200K' },
    { value: '1048576', label: '1M' },
  ];
  /** Accordion: the single client whose config form is expanded (null = all
   *  collapsed). Single-open by design — the forms are tall, and every draft
   *  lives in page-level state keyed by client name, so collapsing never loses
   *  edits and opening a form is always a deliberate user action. */
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Access-mode tabs: 'hook' = setup adapters writing tokens/models into the
   *  client's own config, 'proxy' = forward-proxy hooks (service env or launcher
   *  scripts), 'manual' = the hookup guide for anything the gateway can't auto-hook. */
  const [activeTab, setActiveTab] = useState<'hook' | 'proxy' | 'manual'>('hook');
  /** Manual-tab connectivity probe: optional API key draft + last result. */
  const [manualKey, setManualKey] = useState('');
  const [manualTest, setManualTest] = useState<{ state: 'running' | 'ok' | 'fail'; detail?: string } | null>(null);
  /** Hook-tab filter: case-insensitive substring over display name, adapter
   *  name and config path — the client roster keeps growing. */
  const [filter, setFilter] = useState('');
  /** Live gateway port for the manual-endpoint guide (status poll; the
   *  snippet helper owns the origin/daemon fallbacks and the viewer host). */
  const [port, setPort] = useState<string>('');
  const gwBase = gatewayBaseUrl(port ? Number(port) : undefined);
  /** Inbound forward-proxy runtime state — the proxy-tab prerequisite banner
   *  reads it (null = older gateway without the field, banner suppressed). */
  const [fpEnabled, setFpEnabled] = useState<boolean | null>(null);
  const [fpRunning, setFpRunning] = useState<boolean | null>(null);
  /** Exact MITM CA path (from the console CA card) for the trust hints —
   *  the CA is machine-wide now, so the hint must print the real path rather
   *  than assume it lives under this book-set's OCR_HOME. */
  const [caPath, setCaPath] = useState('');
  /** OS trust verdict for the MITM CA — the proxy tab's prerequisite banner
   *  names it before the operator hooks a launcher and discovers TLS failures
   *  only at use time. */
  const [caTrust, setCaTrust] = useState<CaTrustResponse | null>(null);
  const loadClients = async () => {
    try {
      const data = await api.getStatus();
      // ONE normalization point: every filter/card below reads `hookKind`
      // unconditionally, and a gateway predating the field must classify as
      // 'config' (keeps the API-key gate) rather than as a keyless proxy hook.
      setClients((data.clients || []).map(c => ({ ...c, hookKind: c.hookKind ?? 'config' })));
      if (data.port) setPort(String(data.port));
      setFpEnabled(data.forwardProxy ? data.forwardProxy.enabled : null);
      setFpRunning(data.forwardProxy ? data.forwardProxy.running : null);
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
      // A proxy client's model surface is owned by its gateway PLUGIN, not by
      // the launcher adapter: re-read the plugin list on every status refresh
      // so installing/enabling it updates the cards without a full reload.
      opencodeApi.listPlugins()
        .then((res) => {
          const next: Record<string, GatewayPluginState> = {};
          for (const id of new Set(Object.values(GATEWAY_PLUGIN_BY_CLIENT))) {
            const plugin = (res.plugins || []).find((p) => p.id === id);
            next[id] = {
              installed: !!plugin,
              loaded: !!plugin?.loaded && !plugin?.disabled,
              disabled: !!plugin?.disabled,
              view: plugin ?? null,
            };
          }
          setGatewayPlugins(next);
        })
        .catch(err => console.error('gateway plugin status:', err));
      // pi/omp role rows live in the same link-table draft shape as opencode's:
      // seeded from the slot echo (bare ref / native pin verbatim), then the
      // profile-link echo re-tags linked roles to `slot:<key>`.
      setBindSel(prev => {
        const next = { ...prev };
        for (const c of data.clients || []) {
          if (!isRoleTableClient(c.name) || next[c.name] !== undefined) continue;
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
    api.getClientProfileMemory().then(m => { memRef.current = m; setMem(m); }).catch(() => { memRef.current = {}; setMem({}); });
    api.getProxyCaMeta().then(m => setCaPath(m.path)).catch(() => {});
    api.getProxyCaTrust().then(setCaTrust).catch(() => {});
  }, []);

  const expandedPluginId = expanded ? GATEWAY_PLUGIN_BY_CLIENT[expanded] : undefined;

  // A gateway client's model surface is plugin config, not the launcher
  // adapter. Load it only when the card is opened AND the plugin is loaded; a
  // missing/disabled plugin has no config endpoint and must not look like an
  // empty catalog.
  useEffect(() => {
    if (!expandedPluginId) return;
    if (gatewayCfg[expandedPluginId] || !gatewayPlugins[expandedPluginId]?.loaded) return;
    let alive = true;
    setGatewayCfgBusy((prev) => ({ ...prev, [expandedPluginId]: true }));
    opencodeApi.getPluginConfig(expandedPluginId)
      .then((cfg) => {
        if (!alive) return;
        const parsed = parseGatewayCfg(cfg.values ?? {}, gatewayVocabulary(cfg.schema ?? []));
        setGatewayCfg((prev) => ({ ...prev, [expandedPluginId]: parsed }));

      })
      .catch((err) => { if (alive) console.error(`${expandedPluginId} plugin config:`, err); })
      .finally(() => {
        if (alive) setGatewayCfgBusy((prev) => ({ ...prev, [expandedPluginId]: false }));
      });
    return () => { alive = false; };
  }, [expandedPluginId, gatewayCfg, gatewayPlugins, apiKeys]);

  // Follow mode on a gateway card is the same snapshot idea as the clients
  // above: the card's picked key is the single source, so its effective view
  // is loaded for the live preview; Save writes the snapshot into the plugin.
  useEffect(() => {
    const pending = new Set<string>();
    for (const [pluginId, draft] of Object.entries(gatewayCfg)) {
      if (draft.modelListMode !== 'follow') continue;
      const clientName = CLIENT_BY_GATEWAY_PLUGIN[pluginId];
      const picked = apiKeys.find((k) => k.key === (apiKeySel[clientName] || ''));
      if (picked && !keyModels[picked.id]) pending.add(picked.id);
    }
    for (const keyId of pending) {
      api.getKeyModels(keyId)
        .then((view) => setKeyModels((prev) => ({ ...prev, [keyId]: view })))
        .catch(() => {});
    }
  }, [gatewayCfg, keyModels, apiKeySel, apiKeys]);

  // Seed the gateway card's key picker from the stored binding once BOTH the
  // plugin config and the key list are available (they load independently).
  // An in-page pick always wins; this only fills an empty slot.
  useEffect(() => {
    if (!expandedPluginId) return;
    const parsed = gatewayCfg[expandedPluginId];
    if (!parsed?.boundKeyId) return;
    const clientName = CLIENT_BY_GATEWAY_PLUGIN[expandedPluginId];
    const bound = apiKeys.find((k) => k.id === parsed.boundKeyId);
    if (!bound) return;
    setApiKeySel((prev) => (prev[clientName] ? prev : { ...prev, [clientName]: bound.key }));
  }, [expandedPluginId, gatewayCfg, apiKeys]);

  /** Catalog-relevant draft fields differ from the committed values — after
   *  such a save the client must re-read its own model list. Follow mode always
   *  re-snapshots the key's allowed list at save time, so it counts too. */
  const gatewayCatalogDirty = (draft: GatewayCfgDraft): boolean => {
    const base = parseGatewayCfg(draft.values ?? {}, draft);
    return (
      draft.model !== base.model ||
      draft.forceModel !== base.forceModel ||
      draft.catalogReplace !== base.catalogReplace ||
      draft.catalogPrefix !== base.catalogPrefix ||
      draft.modelListMode !== base.modelListMode ||
      !sameModelSelection(draft.models, base.models) ||
      draft.modelListMode === 'follow'
    );
  };

  /** Persist the card's model-catalog draft into the plugin config. Returns
   *  false when nothing was saved (no draft, no usable key, write failed) —
   *  the takeover path uses that to refuse a half-applied hook. */
  const saveGatewayCfg = async (pluginId: string): Promise<boolean> => {
    const draft = gatewayCfg[pluginId];
    if (!draft) return false;
    const catalogChanged = gatewayCatalogDirty(draft);
    // Every OCR-routed completion is charged to this key (ADR-0017): limits,
    // model access and usage attribution all hang on it, so the card cannot
    // save an unbound gateway.
    const clientName = CLIENT_BY_GATEWAY_PLUGIN[pluginId];
    const picked = apiKeys.find((k) => k.key === (apiKeySel[clientName] || ''));
    if (!picked) {
      toast.error(t('clients.apiKeyRequired'));
      return false;
    }
    // A dead key would make every OCR-routed turn 401 at dispatch; refuse the
    // save instead of persisting a binding that looks configured.
    const expiry = picked.expiresAt ? Date.parse(picked.expiresAt) : NaN;
    if (picked.enabled === false || (!Number.isNaN(expiry) && expiry <= Date.now())) {
      toast.error(t('clients.apiKeyUnusable'));
      return false;
    }
    setGatewayCfgBusy((prev) => ({ ...prev, [pluginId]: true }));
    try {
      let models = draft.models;
      if (draft.modelListMode === 'follow') {
        // Always re-read: the snapshot must reflect the key's policy at save
        // time, never a list cached before the operator changed it.
        const view = await api.getKeyModels(picked.id);
        setKeyModels((prev) => ({ ...prev, [picked.id]: view }));
        models = view.models.filter((model) => model.allowed).map((model) => model.id);
      }
      // The unset mode may hide the concrete default from the list, but a
      // configured id stays a real routing target: forceModel and unpinned
      // requests resolve it against the full registry.
      const model = draft.model;
      const values = {
        ...draft.values,
        model,
        forceModel: draft.forceModel,
        catalogReplace: draft.catalogReplace,
        catalogPrefix: draft.catalogPrefix,
        // Persist the plugin's own unset spelling — `none` is UI vocabulary.
        modelListMode: gatewayModeValue(draft, draft.modelListMode),
        models,
        ...(draft.keyField ? { [draft.keyField]: picked.id } : {}),
      };
      const res = await opencodeApi.putPluginConfig(pluginId, values);
      setGatewayCfg((prev) => ({ ...prev, [pluginId]: parseGatewayCfg(res.values ?? values, draft) }));
      // Only a catalog-shaped save needs the client to re-read its list; a
      // dropped value (warning) means the advertised list did NOT change.
      setGatewaySavedNotice((prev) => ({ ...prev, [pluginId]: catalogChanged && res.warnings.length === 0 }));
      // The backend drops keys the running plugin build does not declare (a
      // gateway started before the manifest listed them), so a plain success
      // toast would report a save that silently lost the model choice.
      if (res.warnings.length > 0) {
        toast.warning(t('clients.gatewaySaveDropped', { warnings: res.warnings.join('; ') }));
      } else {
        toast.success(t('pluginPage.configSaved'));
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setGatewayCfgBusy((prev) => ({ ...prev, [pluginId]: false }));
    }
  };

  /** The catalog draft no longer matches the values it was parsed from — the
   *  operator changed a mode/chip/default and expects the next takeover to
   *  apply it, exactly like the explicit Save button would. */
  const gatewayDraftDirty = (draft: GatewayCfgDraft | undefined, clientName: string): boolean => {
    if (!draft) return false;
    const base = parseGatewayCfg(draft.values ?? {}, draft);
    const pickedId = apiKeySel[clientName] ? keyIdOf(apiKeySel[clientName]) : '';
    return (
      draft.model !== base.model ||
      draft.forceModel !== base.forceModel ||
      draft.catalogReplace !== base.catalogReplace ||
      draft.catalogPrefix !== base.catalogPrefix ||
      draft.modelListMode !== base.modelListMode ||
      !sameModelSelection(draft.models, base.models) ||
      draft.boundKeyId !== pickedId
    );
  };

  /** Seed selections once BOTH sources are in: the committed form memory
   *  (the full snapshot the last setup applied — see rememberDraft) wins —
   *  the form restores what the user last hooked, not external drift — and
   *  the live echo fills what memory cannot express (foreign pins, installs
   *  made outside this console).
   *  Per-client undefined guard never clobbers in-page edits. */
  useEffect(() => {
    if (mem === null || !profilesReady) return;
    // API-key form memory: the last-written key re-seeds the picker (resolved
    // by stable id, never the raw token). A stale id (deleted/disabled key)
    // seeds nothing — setup then demands a fresh pick. Gateway clients are
    // excluded: their picker belongs to the plugin card and seeds from the
    // stored gateway binding, so a stale setup memory must never masquerade as
    // the current binding (saving the card would then rewrite the binding).
    setApiKeySel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (next[c.name] !== undefined || GATEWAY_PLUGIN_BY_CLIENT[c.name]) continue;
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
        const candidate = mem[c.name]?.profile || c.profile?.id || '';
        next[c.name] = candidate && profiles.some(p => p.id === candidate) ? candidate : '';
      }
      return next;
    });
    setLinksOn(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (c.name !== 'opencode' && !isRoleTableClient(c.name)) continue;
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
        // opencode seeds from the live agent inventory; pi/omp seed from their
        // role slots (see loadClients) — their draft values carry slot links,
        // not just refs.
        if (c.name === 'opencode' || isRoleTableClient(c.name)) continue;
        if (next[c.name] === undefined) next[c.name] = mem[c.name]?.bindings || c.profile?.bindings || {};
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
    setVirtualSel(prev => {
      const next = { ...prev };
      for (const c of clients) {
        if (!supportsExtraModels(c.name) || next[c.name] !== undefined) continue;
        // Memory is the only source: the config echo cannot express a scoped
        // virtual block (getStatus strips the router-owned ids), so an absent
        // memory entry stays undefined = adapter default.
        next[c.name] = mem[c.name]?.virtualModels;
      }
      return next;
    });

    // Extras: the committed snapshot wins over the echo seed on first
    // hydration (loadClients already claimed the slot from the config echo).
    // A ref marks each client hydrated so late effect re-runs (apiKeys or
    // profiles arriving) never clobber in-page edits.
    const freshExtras = clients.filter(c => !extrasSeeded.current.has(c.name));
    for (const c of freshExtras) extrasSeeded.current.add(c.name);
    setExtraSel(prev => {
      const next = { ...prev };
      for (const c of freshExtras) {
        const extras = mem[c.name]?.extraModels;
        if (extras !== undefined) next[c.name] = [...extras];
      }
      return next;
    });
  }, [clients, mem, profilesReady, profiles, apiKeys]);

  /** Slot-key tags behind a client's drafts — the `slot:<key>` values only.
   *  opencode keeps them in the agent-table draft (bindSel); pi/omp keep them
   *  in the role-link table draft (bindSel — loadClients seeds it, the table
   *  renders it). Memory persists tags so links survive reloads. */
  const linkTagsOf = (draft: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(
      Object.entries(draft || {})
        .filter(([k, v]) => k !== 'main' && typeof v === 'string' && v.startsWith('slot:'))
        .map(([a, v]) => [a, v.slice(5)])
    );

  /** COMMIT-POINT form memory: called ONLY when a setup APPLIED something —
   *  never on mid-form edits (draft fiddling must not overwrite the memory of
   *  the last applied configuration; it would also storm the config-write
   *  path with whole-config POSTs per pick). Snapshots the FULL form state
   *  the setup applied: link tags, manual role/agent refs (native pins
   *  included), pi/omp main pick, slot drafts, the custom model-list draft,
   *  mode, key id and the link-table toggle. Written into the ACTIVE
   *  environment's config.yaml (book-set scoped — switching envs switches
   *  the memory too). memRef keeps two rapid commits from clobbering each
   *  other via a stale snapshot. */
  const rememberDraft = (clientName: string) => {
    const ms = modelSel[clientName] || {};
    const ds = bindSel[clientName] || {};
    const roleRows = isRoleTableClient(clientName) || clientName === 'opencode';
    const entry: ClientProfileMemoryEntry = {
      profile: profileSel[clientName] || '',
      // Link tags plus the raw manual refs verbatim (native pins included) —
      // the snapshot must reproduce the rows exactly as the form showed them.
      bindings: linkTagsOf(ds),
      agentModels: roleRows
        ? Object.fromEntries(Object.entries(ds).filter(([, v]) => v && v !== 'auto' && !v.startsWith('slot:')))
        : undefined,
      models: clientName === 'opencode'
        ? undefined
        : isRoleTableClient(clientName)
          ? { main: ms.main || 'auto' }
          : ms,
      extraModels: extraSel[clientName] || [],
      virtualModels: virtualSel[clientName],
      modelMode: modeSel[clientName] ?? 'none',
      apiKeyId: keyIdOf(apiKeySel[clientName] || ''),
      linksOn: linksOn[clientName],
    };
    // Pure updater required: computing `next` (and firing the POST) inside the
    // setMem updater would double-invoke under StrictMode / concurrent render.
    const next = { ...(memRef.current || mem || {}), [clientName]: entry };
    memRef.current = next;
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

  /** The key's allowed model view (follow preview): virtual tier entries the
   *  policy admits (injected by the adapters per the same verdict) plus the
   *  allowed concrete rows — mirrors the API-key effective view exactly. */
  const followExtrasOf = (k: ApiKeyItem): string[] =>
    (keyModels[k.id]?.models || []).filter(m => m.allowed).map(m => m.id);

  /** Flip the model-list source (draft only — the setup commit persists it). */
  const setModelMode = (clientName: string, mode: 'none' | 'custom' | 'follow') => {
    setModeSel(prev => ({ ...prev, [clientName]: mode }));
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

  /** `product` narrows a family card's action to ONE product (JetBrains IDEs). */
  const handleToggle = async (clientName: string, action: 'setup' | 'teardown', product?: string) => {
    // Every refusal below fires while the card may still be collapsed — the fix
    // (key picker, model mode, context form) lives inside the panel, so reveal
    // it alongside the toast instead of making the operator find the row again.
    const revealCard = () => setExpanded(clientName);
    // Form-validation feedback for the key picker: flag it red, open the card,
    // then scroll + focus the field once React has committed the expansion.
    const flagKeyError = () => {
      setKeyError((prev) => ({ ...prev, [clientName]: true }));
      setExpanded(clientName);
      // Smooth-scroll first, then focus with `preventScroll` — a plain focus()
      // teleports instantly and races the smooth scroll, producing a jump.
      requestAnimationFrame(() => {
        const el = keyPickerRefs.current[clientName];
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el?.focus({ preventScroll: true });
      });
    };
    // A retry starts from a clean slate — the old red box must not survive a
    // fresh attempt that may pass this time.
    clearKeyError(clientName);
    setLoading(true);
    try {
      // A gateway client's model list is the plugin config, not the launcher
      // adapter — takeover must apply the catalog draft the card is showing,
      // or the hook lands with the plugin still on its old list (the classic
      // "picked follow, still only auto + tiers" report). The explicit Save
      // button keeps the same contract; this only mirrors it.
      const gatewayPluginId = GATEWAY_PLUGIN_BY_CLIENT[clientName];
      if (action === 'setup' && gatewayPluginId) {
        // Every OCR-routed turn is charged to the bound key; a takeover without
        // one produces a hooked client that 401s on every OCR model. Refuse it
        // here instead of letting setup succeed half-configured.
        const picked = apiKeys.find((k) => k.key === (apiKeySel[clientName] || ''));
        const expiry = picked?.expiresAt ? Date.parse(picked.expiresAt) : NaN;
        if (!picked || picked.enabled === false || (!Number.isNaN(expiry) && expiry <= Date.now())) {
          toast.error(t('clients.gatewayKeyRequired'));
          flagKeyError();
          return;
        }
        if (gatewayDraftDirty(gatewayCfg[gatewayPluginId], clientName)) {
          if (!(await saveGatewayCfg(gatewayPluginId))) { revealCard(); return; }
        }
      }
      let extras = extraSel[clientName] || [];
      let virtuals: string[] | undefined;
      if (action === 'setup' && supportsExtraModels(clientName)) {
        const mode = modeSel[clientName] ?? 'none';
        if (mode === 'none') {
          // Explicit 'none': no concrete extras; the virtual block stays at the
          // adapter default (full auto* block for the JSON clients, none for grok).
          extras = [];
        } else if (mode === 'follow') {
          // Follow mode: the hook exposes exactly the models the picked key can
          // use (snapshot at setup — the key's policy is the single source of
          // truth). Virtual tier entries ride separately: the adapters inject
          // the `allowed` subset, so the switcher matches the key's effective
          // view instead of promising entries the policy would 403.
          const k = followKeyOf(clientName);
          if (!k) {
            toast.error(t('clients.followNoKey'));
            revealCard();
            return;
          }
          const view = keyModels[k.id] || (await api.getKeyModels(k.id));
          setKeyModels(prev => (prev[k.id] ? prev : { ...prev, [k.id]: view }));
          extras = view.models.filter(m => !m.virtual && m.allowed).map(m => m.id);
          virtuals = view.models.filter(m => m.virtual && m.allowed).map(m => m.id);
        } else {
          // Custom mode: the virtual-tier draft decides the block — undefined
          // (untouched) stays absent so the adapter default applies; an array
          // (possibly empty) scopes the block to that set.
          virtuals = virtualSel[clientName];
        }
      }
      // The picker is mandatory for key-writing clients: without an explicit
      // key there is nothing to write — refuse rather than silently keep the
      // previous token. Proxy hooks write no key at all (service env or
      // launcher scripts), so they are exempt — their form does not even
      // render the key picker.
      const hookKind = clients.find(c => c.name === clientName)?.hookKind ?? 'config';
      const keyless = hookKind !== 'config';
      if (action === 'setup' && !keyless && !(apiKeySel[clientName] || '')) {
        toast.error(t('clients.apiKeyRequired'));
        flagKeyError();
        return;
      }
      const piPayload = piLinkPayload(clientName);
      const agentPayload = opencodeAgentPayload(clientName);
      const res = await api.toggleClient(clientName, action, action === 'setup' ? {
        models: piPayload.models,
        ...(keyless && !gatewayPluginId ? {} : { apiKey: apiKeySel[clientName] }),
        contextWindow: Number(ctxSel[clientName] || '262144'),
        extraModels: extras,
        ...(virtuals !== undefined ? { virtualModels: virtuals } : {}),
        ...(piPayload.agentModels ? { agentModels: piPayload.agentModels } : {}),
        profile: piPayload.profile,
        ...agentPayload,
        ...(product ? { product } : {}),
      } : product ? { product } : undefined);
      // Proxy-mode notices are backend prose — show a localized one-liner instead
      // (the long hints live in the expanded card).
      setActionNotice(
        clientName === 'opencode-proxy'
          ? t(action === 'setup' ? 'clients.proxySetupOk' : 'clients.proxyTeardownOk')
          : clientName === 'cursor-proxy'
            ? t(action === 'setup' ? 'clients.cursorSetupOk' : 'clients.cursorTeardownOk')
            : clientName === 'qoder-proxy'
              ? t(action === 'setup' ? 'clients.qoderSetupOk' : 'clients.qoderTeardownOk')
              : clientName === 'jetbrains-proxy'
                ? t(action === 'setup' ? 'clients.jetbrainsSetupOk' : 'clients.jetbrainsTeardownOk')
                : (res.message || 'Updated')
      );
      // Setup succeeded, but the hooked client can still fail at USE time
      // (untrusted CA, proxy not listening). Advise, never block: the CA is
      // routinely imported right after hooking.
      if (action === 'setup' && res.warnings?.length) {
        // Show ALL advisories: a listener warning must not hide the CA one.
        const warnKey: Record<string, string> = {
          ca_not_trusted: 'clients.warnCaNotTrusted',
          ca_trust_unknown: 'clients.warnCaTrustUnknown',
          proxy_not_running: 'clients.warnProxyNotRunning',
          ide_running: 'clients.warnIdeRunning',
          ide_truststore_readonly: 'clients.warnIdeTruststoreReadonly',
          junie_install_failed: 'clients.warnJunieInstallFailed',
          junie_models_failed: 'clients.warnJunieModelsFailed',
        };
        toast.warning(res.warnings.map(warn => t(warnKey[warn.code] ?? 'clients.warnProxyNotRunning', warn.params)).join(' '));
      }
      if (action === 'setup') {
        // The hook's forced probe just refreshed the backend cache; mirror it so
        // the tab banner agrees with the toast immediately.
        api.getProxyCaTrust().then(setCaTrust).catch(() => {});
        // Write-through: the memory mirrors the drafts this setup just
        // applied — the same selections the payload was built from.
        rememberDraft(clientName);
      }
      // Refresh the agent inventory cache and drop the link draft so the
      // table re-seeds from the committed config (the lazy-load effect
      // refetches; the seed effect re-tags linked rows from the fresh echo).
      if (clientName === 'opencode') setAgents(null);
      if (clientName === 'opencode' || isRoleTableClient(clientName)) {
        setBindSel(prev => {
          const { [clientName]: _dropped, ...rest } = prev;
          return rest;
        });
      }
      await loadClients();
      setTimeout(() => setActionNotice(null), 3000);
    } catch (err: any) {
      toast.error(clientActionErrorText(err, t));
      revealCard();
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

  /** Restore the form drafts to the remembered form state (the write-through
   *  mirror of the last selections — see rememberDraft). STRICTLY from memory,
   *  no live-echo fallback: a field without memory resets to its blank/default
   *  instead of borrowing the current config state (predictable over clever:
   *  no memory → nothing to restore). Useful after a setup re-seeded the link
   *  drafts from the config echo. Purely a draft operation — client config
   *  files and the memory itself are never touched (hook removal is
   *  Teardown's job, re-apply is Setup's). */
  const handleResetModel = (clientName: string) => {
    const c = clients.find(x => x.name === clientName);
    const m = mem?.[clientName];
    const memTags = m?.bindings || {};
    const memModels = m?.models || {};
    const memAgent = m?.agentModels || {};
    // Slot drafts: memory link tags re-tag linked slots; the committed ref
    // snapshot restores manual picks; the slot's role default is the last
    // resort — the live echo is deliberately NOT consulted.
    const slots: Record<string, string> = {};
    for (const s of clientSlots(c)) {
      const tag = memTags[s.key];
      slots[s.key] = s.key !== 'main' && tag ? `slot:${tag}` : (memModels[s.key] || s.default || 'auto');
    }
    setModelSel(prev => ({ ...prev, [clientName]: slots }));
    setExtraSel(prev => ({ ...prev, [clientName]: m?.extraModels ? [...m.extraModels] : [] }));
    setVirtualSel(prev => ({ ...prev, [clientName]: m?.virtualModels }));
    const candidate = m?.profile || '';
    setProfileSel(prev => ({ ...prev, [clientName]: candidate && profiles.some(p => p.id === candidate) ? candidate : '' }));
    if (isRoleTableClient(clientName)) {
      // pi/omp role drafts live in bindSel (loadClients seeds them there and
      // the link table renders from it): memory link tags re-link the role,
      // the committed agentModels restore manual refs, everything else blanks.
      setBindSel(prev => {
        const draft: Record<string, string> = {};
        for (const s of clientSlots(c)) {
          if (s.key === 'main') continue;
          draft[s.key] = memTags[s.key] ? `slot:${memTags[s.key]}` : (memAgent[s.key] || '');
        }
        return { ...prev, [clientName]: draft };
      });
    } else if (clientName === 'opencode') {
      // Memory tags re-link agents, remembered agentModels restore manual refs
      // verbatim; agents the user never picked stay unselected (blank — the
      // mirror records what the form showed, it never invents an 'auto' pick).
      setBindSel(prev => {
        const draft: Record<string, string> = {};
        for (const a of agents || []) draft[a.name] = memTags[a.name] ? `slot:${memTags[a.name]}` : (memAgent[a.name] || '');
        return { ...prev, [clientName]: draft };
      });
    } else {
      setBindSel(prev => ({ ...prev, [clientName]: { ...memTags } }));
    }
    setModeSel(prev => ({ ...prev, [clientName]: m?.modelMode || 'none' }));
    setApiKeySel(prev => {
      const next = { ...prev };
      const k = m?.apiKeyId ? apiKeys.find(x => x.id === m.apiKeyId) : undefined;
      next[clientName] = k ? k.key : '';
      return next;
    });
    if (clientName === 'opencode' || isRoleTableClient(clientName)) {
      setLinksOn(prev => ({ ...prev, [clientName]: m?.linksOn ?? Object.keys(memTags).length > 0 }));
    }
  };

  const slotLabels: Record<string, string> = {
    main: t('clients.slotMain'),
    opus: t('clients.slotOpus'),
    sonnet: t('clients.slotSonnet'),
    haiku: t('clients.slotHaiku'),
    fable: t('clients.slotFable'),
    fallback: t('clients.slotFallback'),
    utility: t('clients.slotUtility'),
    decision: t('clients.slotDecision'),
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

  /** pi/omp payload: main stays a plain model pick; the role-link table's
   *  drafts split into manual refs (agentModels) and profile-link tags
   *  (`slot:<key>`, resolved server-side). Native pins echoed verbatim are
   *  never re-sent. Other clients pass their slot map through unchanged. */
  const piLinkPayload = (clientName: string): { models: Record<string, string>; agentModels?: Record<string, string>; profile?: { id: string; bindings: Record<string, string> } } => {
    if (!isRoleTableClient(clientName)) return { models: modelSel[clientName] || {} };
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
    if (isRoleTableClient(c.name)) {
      targets = clientSlots(c)
        // Profile mode: skip `main` — it stays a plain model pick, never a
        // profile-link tag (`slot:<key>` would corrupt the primary model).
        .filter(s => !profileMode || s.key !== 'main')
        .map(s => ({
          key: s.key,
          label: slotLabels[s.key] || s.key,
          // The role's own description (agent file / roster); the decider uses
          // it as context. Never synthesized — role sets are discovered.
          role: s.description,
          current: s.key === 'main' ? modelSel[c.name]?.main : bindSel[c.name]?.[s.key],
        }));
    } else if (c.name === 'opencode') {
      targets = (agents || []).map(a => ({ key: a.name, label: a.name, role: a.description || a.mode, current: bindSel[c.name]?.[a.name] }));
    } else {
      targets = clientSlots(c).map(s => ({ key: s.key, label: slotLabels[s.key] || s.key, role: s.description, current: modelSel[c.name]?.[s.key] }));
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
    if (isRoleTableClient(clientName)) {
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

  /** Multi-select toggle → route the next set into the two drafts: virtual
   *  tier ids into the virtual draft (materializing the adapter default only
   *  when the set actually changes — an untouched draft keeps the payload
   *  absent), everything else into the concrete extras draft. */
  const applyModelDraft = (clientName: string, next: string[]) => {
    const virtualNext = next.filter(id => VIRTUAL_TIER_IDS.includes(id));
    setExtraSel(prev => ({ ...prev, [clientName]: next.filter(id => !VIRTUAL_TIER_IDS.includes(id)) }));
    setVirtualSel(prev => {
      const effective = prev[clientName] ?? virtualDefaultFor(clientName);
      const changed = virtualNext.length !== effective.length || virtualNext.some(id => !effective.includes(id));
      return changed ? { ...prev, [clientName]: virtualNext } : prev;
    });
  };

  const removeExtraModel = (clientName: string, id: string) => {
    if (VIRTUAL_TIER_IDS.includes(id)) {
      // Removing a default-present virtual entry materializes the draft
      // (adapter default minus this id); an already-materialized draft just
      // drops the id. Untouched drafts keep the payload absent.
      setVirtualSel(prev => {
        const cur = prev[clientName] ?? virtualDefaultFor(clientName);
        return { ...prev, [clientName]: cur.filter(m => m !== id) };
      });
      return;
    }
    setExtraSel(prev => ({ ...prev, [clientName]: (prev[clientName] || []).filter(m => m !== id) }));
  };

  const extraOptions = () =>
    // The whole catalog stays listed — multi-select toggles in place (the
    // checkmark marks what is on), so present entries must remain pickable
    // for un-toggling inside the panel. Filter by catalog kind for badges,
    // never by id prefix: registered ids may legally start with "auto".
    models.map(m => ({ value: m.id, label: m.id, ...modelRefBadge(m.kind, t) }));

  /** Clear the whole custom model draft in one click (chips are per-model; bulk reset needs its own affordance):
   *  concrete picks empty out, the virtual draft returns to "untouched" (adapter default block). */
  const clearExtraModels = (clientName: string) => {
    setExtraSel(prev => ({ ...prev, [clientName]: [] }));
    setVirtualSel(prev => ({ ...prev, [clientName]: undefined }));
  };

  /** Effective virtual set for display: the explicit draft, else the adapter default. */
  const effectiveVirtualTiers = (clientName: string): string[] =>
    virtualSel[clientName] ?? virtualDefaultFor(clientName);

  /** Chip wall for the model-list editor (follow snapshot / custom picks).
   *  Long lists truncate to the first MODEL_CHIP_LIMIT chips with a "+N more"
   *  toggle — 85 flat chips bury the rest of the card (user escalation). */
  const renderModelChips = (clientName: string, ids: string[], onRemove?: (id: string) => void, trailing?: React.ReactNode, cell?: React.CSSProperties) => {
    const open = !!extrasOpen[clientName];
    const truncated = !open && ids.length > MODEL_CHIP_LIMIT;
    const shown = truncated ? ids.slice(0, MODEL_CHIP_LIMIT) : ids;
    const chipStyle: React.CSSProperties = {
      padding: '3px 10px',
      borderRadius: '999px',
      border: '1px solid var(--card-border)',
      fontSize: 'var(--text-xs)',
      fontFamily: FONT_MONO,
    };
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginBottom: '6px', ...cell }}>
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

  /** Inline model-catalog editor for a gateway-backed client. The plugin owns
   *  the catalog; this card edits the model-catalog subset of its config
   *  (mode / snapshot / replace / default / force), while the Plugins drawer
   *  holds the protocol/runtime keys. Same contract for every gateway client. */
  const renderGatewayCatalog = (c: ClientStatus) => {
    const pluginId = GATEWAY_PLUGIN_BY_CLIENT[c.name];
    if (!pluginId) return null;
    const plugin = gatewayPlugins[pluginId];
    const draft = gatewayCfg[pluginId];
    const busy = !!gatewayCfgBusy[pluginId];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: 'var(--text-xs)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-dim)' }}>
          {t('clients.gatewayModels', { client: c.displayName })}{' '}
          <InfoTip text={t('clients.gatewayModelsInfo', { client: c.displayName })} />
        </div>
        {plugin && !plugin.loaded ? (
          <div style={{ color: 'var(--accent-amber)', lineHeight: 'var(--leading-normal)' }}>
            {plugin.installed
              ? t(plugin.disabled ? 'clients.gatewayPluginDisabled' : 'clients.gatewayPluginNotLoaded', { client: c.displayName })
              : t('clients.gatewayPluginMissing', { client: c.displayName })}
          </div>
        ) : busy && !draft ? (
          <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>
        ) : draft ? (
          (() => {
            const mode = draft.modelListMode;
            const followKey = apiKeys.find((key) => key.key === (apiKeySel[c.name] || ''));
            const followView = followKey ? keyModels[followKey.id] : undefined;
            const listed = mode === 'none'
              // "Unset" is gateway-defined: `all` advertises the whole
              // registry, the tier-only spelling advertises auto*.
              ? draft.unsetMode === 'all'
                ? models.map((model) => model.id)
                : VIRTUAL_TIER_IDS
              : mode === 'custom'
                ? draft.models
                : followView
                  ? followView.models.filter((model) => model.allowed).map((model) => model.id)
                  : draft.models;
            const visible = [...new Set(listed)];
            const defaultOptions = [...new Set([
              draft.model,
              ...visible,
            ].filter(Boolean))];
            const update = (patch: Partial<GatewayCfgDraft>): void => {
              // The notice describes the last COMMITTED save — a new draft edit
              // makes it stale (the next save re-raises it when needed).
              setGatewaySavedNotice((prev) => (prev[pluginId] ? { ...prev, [pluginId]: false } : prev));
              setGatewayCfg((prev) => (prev[pluginId] ? { ...prev, [pluginId]: { ...prev[pluginId], ...patch } } : prev));
            };
            return (
              /* Form layout: one label column (sized by the widest label, so
                 every label starts on the same rail) and one value column.
                 Everything that is not a label is a VALUE of its row: the mode
                 toggles, the chip wall and the replace toggle belong to the
                 model-list row; the force toggle belongs to the default-model
                 row; the actions close the value column. Baselines align so a
                 label sits on the text line of the control it names. */
              <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: '8px', rowGap: '12px', alignItems: 'baseline' }}>
                <span style={{ gridColumn: 1, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {t('clients.gatewayApiKey')}{' '}
                  <InfoTip text={t('clients.gatewayApiKeyHint')} />
                </span>
                <Combobox
                  style={{ gridColumn: 2, minWidth: 0 }}
                  value={apiKeySel[c.name] || ''}
                  onChange={(v) => {
                    setGatewaySavedNotice((prev) => (prev[pluginId] ? { ...prev, [pluginId]: false } : prev));
                    setApiKeySel((prev) => ({ ...prev, [c.name]: v }));
                    clearKeyError(c.name);
                  }}
                  options={apiKeys.map((key) => ({
                    value: key.key,
                    label: key.name,
                    meta: key.key.length > 12 ? `${key.key.slice(0, 8)}…${key.key.slice(-4)}` : undefined,
                  }))}
                  placeholder={t('clients.apiKeySelect')}
                  panelMinWidth={320}
                  invalid={!!keyError[c.name]}
                  triggerRef={el => { keyPickerRefs.current[c.name] = el; }}
                />
                {!apiKeySel[c.name] ? (
                  <span style={{ gridColumn: '1 / -1', color: 'var(--accent-amber)', fontSize: 'var(--text-xs)' }}>
                    {t('clients.gatewayKeyRequired')}
                  </span>
                ) : null}

                <span style={{ gridColumn: 1, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{t('clients.gatewayModelList')}</span>
                <div style={{ gridColumn: 2, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {(['none', 'custom', 'follow'] as const).map((uiMode) => {
                      const active = mode === uiMode;
                      return (
                        <button
                          key={uiMode}
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() =>
                            update({ modelListMode: uiMode })
                          }
                          style={active
                            ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
                            : undefined}
                        >
                          {t(uiMode === 'none'
                            ? 'clients.modelModeNone'
                            : uiMode === 'custom'
                              ? 'clients.modelModeCustom'
                              : 'clients.modelModeFollow')}
                        </button>
                      );
                    })}
                  </div>

                  {mode === 'follow' && (
                    !followKey ? (
                      <div style={{ color: 'var(--accent-amber)' }}>{t('clients.followNoKey')}</div>
                    ) : !followView ? (
                      <div style={{ color: 'var(--text-dim)' }}>{t('clients.followLoading')}</div>
                    ) : (
                      <>
                        {renderModelChips(c.name, visible, undefined, undefined, { marginBottom: 0 })}
                        <div style={{ color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                          {t('clients.followCount', { n: visible.length })} · {t('clients.gatewayFollowSnapshot')}
                        </div>
                      </>
                    )
                  )}

                  {mode === 'custom' && (
                    <>
                      <Combobox
                        value=""
                        onChange={(id) => {
                          if (id && !draft.models.includes(id)) {
                            update({ models: [...draft.models, id] });
                          }
                        }}
                        options={models
                          .filter((model) => !draft.models.includes(model.id))
                          .map((model) => ({ value: model.id, label: model.id }))}
                        placeholder={t('clients.addModel')}
                        panelMinWidth={320}
                      />
                      {renderModelChips(
                        c.name,
                        draft.models,
                        (id) => update({ models: draft.models.filter((model) => model !== id) }),
                        undefined,
                        { marginBottom: 0 },
                      )}
                    </>
                  )}

                  {mode === 'none' && (
                    <>
                      {renderModelChips(
                        c.name,
                        visible,
                        undefined,
                        <span style={{ color: 'var(--text-dim)' }}>
                          {t(draft.catalogReplace ? 'clients.gatewayReplaceSummary' : 'clients.gatewayAppendSummary', { n: visible.length })}
                        </span>,
                        { marginBottom: 0 },
                      )}
                      <div style={{ color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                        {t(draft.unsetMode === 'all' ? 'clients.modelModeAllHint' : 'clients.modelModeNoneHint')}
                      </div>
                    </>
                  )}

                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)' }}>
                    <input
                      type="checkbox"
                      checked={draft.catalogReplace}
                      disabled={busy}
                      onChange={(e) => update({ catalogReplace: e.target.checked })}
                    />
                    {t('clients.gatewayReplace', { client: c.displayName })}
                  </label>
                  {/* Replace mode publishes its own unprefixed list, so the
                      prefix only governs the appended entries (same rule the
                      manifest's visibleWhen encodes). */}
                  {!draft.catalogReplace && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)' }}>
                      <input
                        type="checkbox"
                        checked={draft.catalogPrefix}
                        disabled={busy}
                        onChange={(e) => update({ catalogPrefix: e.target.checked })}
                      />
                      {t('clients.gatewayCatalogPrefix')}
                    </label>
                  )}
                </div>

                <span style={{ gridColumn: 1, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{t('clients.gatewayDefaultModel')}</span>
                <div style={{ gridColumn: 2, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
                  <Combobox
                    style={{ minWidth: 0 }}
                    value={draft.model}
                    onChange={(model) => update({ model })}
                    options={defaultOptions.map((id) => ({ value: id, label: id }))}
                    placeholder={t('clients.gatewayDefaultModel')}
                    panelMinWidth={320}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)' }}>
                    <input
                      type="checkbox"
                      checked={draft.forceModel}
                      disabled={busy}
                      onChange={(e) => update({ forceModel: e.target.checked })}
                    />
                    {t('clients.gatewayForceModel')}
                  </label>
                </div>

                <div style={{ gridColumn: 2, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {/* The clickable actions own one row; the auto-save note is a
                      caption beneath it, not a peer control. Before the launcher
                      exists the card's only primary action is "Generate launcher"
                      at the bottom — setup already commits a dirty catalog draft
                      (see handleToggle), so no second Save button is shown. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {c.hooked && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => void saveGatewayCfg(pluginId)}
                      >
                        {t('pluginPage.configSave')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!plugin?.view}
                      onClick={() => setAdvancedPlugin(plugin?.view ?? null)}
                    >
                      {t('clients.gatewayAdvancedSettings')}
                    </button>
                  </div>
                  {!c.hooked && (
                    <span style={{ color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                      {t('clients.gatewayAutoSaveHint')}
                    </span>
                  )}
                </div>
                {gatewaySavedNotice[pluginId] && (
                  <div style={{ gridColumn: '1 / -1', padding: '8px 10px', borderRadius: '6px', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 25%, transparent)', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', lineHeight: 'var(--leading-normal)' }}>
                    {t('clients.gatewayCatalogRestartNotice', { client: c.displayName })}
                  </div>
                )}
              </div>
            );
          })()
        ) : (
          <Link className="btn btn-sm" to={plugin?.installed ? `/plugins?plugin=${pluginId}` : '/plugins'}>
            {plugin?.installed ? t('clients.gatewayConfigureModels') : t('clients.gatewayInstallPlugin')}
          </Link>
        )}
      </div>
    );
  };

  // Owned files are listed the same way on every card (Cursor's launcher-only
  // card and the config-path card alike): one renderer keeps the icon, spacing
  // and wrap behavior in a single place.
  const renderArtifact = (a: ClientArtifact) => (
    <div key={a.path} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', wordBreak: 'break-all', marginTop: '3px' }}>
      {a.exists ? <Check size={12} color="var(--accent-emerald)" style={{ flexShrink: 0 }} /> : <X size={12} color="var(--text-dim)" style={{ flexShrink: 0 }} />}
      <span>{a.path}</span>
    </div>
  );

  /**
   * The launch-command block for a READY launcher client: the `ocr` verb is
   * the actionable next step, so it gets a copyable command row (not buried
   * in hint prose). Hidden until hooked — before that the card's single
   * primary action is generating the launcher, and the command would only
   * invite a run that silently passes through un-proxied.
   */
  const renderLaunchCommands = (c: ClientStatus) => {
    if (!c.hooked || c.hookKind !== 'launcher') return null;
    const cmds = LAUNCH_COMMANDS[c.name];
    if (!cmds) return null;
    const copy = (text: string) =>
      copyToClipboard(text).then((ok) =>
        ok ? toast.success(t('clients.manualCopied')) : toast.error(t('common.failed')),
      );
    // One grid for BOTH rows; the pill column is `minmax(0, max-content)` —
    // sized by the widest command, both pills stretch to the same width, and
    // each pill carries its copy icon at its right edge. A command is a short
    // token, not a form field: hugging the content keeps the button beside
    // the text it copies instead of stranded at the card's far end.
    const row = (label: string, cmd: string) => (
      <div key={cmd} style={{ display: 'contents' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', minWidth: 0, background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '6px', padding: '4px 6px 4px 10px' }}>
          <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: FONT_MONO, fontSize: 'var(--text-sm)', color: 'var(--text-main)' }}>
            {cmd}
          </code>
          <button
            type="button"
            className="btn btn-sm"
            style={{ flexShrink: 0 }}
            title={t('clients.manualCopied')}
            onClick={() => void copy(cmd)}
          >
            <Copy size={11} />
          </button>
        </div>
      </div>
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontWeight: 'var(--font-semibold)' }}>
          {t('clients.launchCmdLabel')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, max-content)', columnGap: '10px', rowGap: '8px', alignItems: 'center' }}>
          {row(t('clients.launchCmdDesktop'), cmds.primary)}
          {row(t('clients.launchCmdAlt'), cmds.alt)}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
          {t('clients.launchCmdQuit', { client: c.displayName })}
        </div>
      </div>
    );
  };

  /** Primary takeover/teardown button; `stretched` fills the form's action row. */
  const renderActionButtons = (c: ClientStatus, stretched: boolean) => {
    // A proxy client's launcher only exists to feed its gateway plugin.
    // Hooking without a loaded plugin would proxy every request transparently
    // while the UI claims OCR is active — block the setup, never the teardown.
    const pluginId = GATEWAY_PLUGIN_BY_CLIENT[c.name];
    const gatewayPlugin = pluginId ? gatewayPlugins[pluginId] : undefined;
    const pluginBlocked = !!pluginId && gatewayPlugin !== undefined && !gatewayPlugin.loaded;
    // A launcher hook only publishes a start script — no client state is taken
    // over until `ocr <client>` launches it. Its buttons say "generate/delete
    // launcher" instead of "take over/tear down (restore original)", which
    // would imply a persistent modification that never happened.
    const isLauncher = c.hookKind === 'launcher';
    return c.hooked ? (
      <button
        className="btn btn-danger btn-sm"
        style={stretched ? { flex: 1 } : undefined}
        onClick={e => { e.stopPropagation(); handleToggle(c.name, 'teardown'); }}
        disabled={loading}
      >
        <Undo2 size={12} />
        <span>{t(isLauncher ? 'clients.launcherTeardownBtn' : 'clients.teardownBtn')}</span>
      </button>
    ) : (
      <button
        className="btn btn-primary btn-sm"
        style={stretched ? { flex: 1 } : undefined}
        onClick={e => { e.stopPropagation(); handleToggle(c.name, 'setup'); }}
        disabled={loading || pluginBlocked}
        title={pluginBlocked ? t('clients.gatewayPluginRequired', { client: c.displayName }) : undefined}
      >
        <ArrowUpRight size={12} />
        <span>{t(isLauncher ? 'clients.launcherSetupBtn' : 'clients.setupBtn')}</span>
      </button>
    );
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', height: '100%', minHeight: 0 }}>
      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="card-header">
          <div className="card-title">
            <Terminal size={18} color="var(--accent)" />
            <span>{t('clients.title')}</span>
            {/* Hooked/total over the roster the active access-mode tab shows
                (hook + proxy); manual hookup has no roster and shows none. */}
            {activeTab !== 'manual' && (() => {
              const roster = clients.filter(c => activeTab === 'proxy' ? c.hookKind !== 'config' : c.hookKind === 'config');
              const hooked = roster.filter(c => c.hooked).length;
              return (
                <span className="badge badge-success" style={{ marginLeft: '10px' }}>
                  {t('clients.hookedCount', { hooked, total: roster.length })}
                </span>
              );
            })()}
          </div>
          <button className="btn btn-sm" onClick={loadClients} disabled={loading}>
            <RefreshCw size={12} />
            <span>{t('clients.refresh')}</span>
          </button>
        </div>

        {actionNotice && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-emerald) 30%, transparent)', color: 'var(--accent-emerald)', fontSize: 'var(--text-md)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Check size={16} />
            <span>{actionNotice}</span>
          </div>
        )}

        {activeTab === 'hook' && (
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)', marginBottom: '12px' }}>
            {t('clients.desc', { base: `${gwBase}/v1` })}
          </p>
        )}

        {/* Access-mode tabs — three ways in: written config (token hook),
            transparent MITM proxy, or a manual baseURL+key hookup. */}
        <div style={{ marginBottom: '16px' }}>
          <SegGroup
            size="lg"
            value={activeTab}
            onChange={v => { setKeyError({}); setActiveTab(v as typeof activeTab); }}
            options={[
              { value: 'hook', label: t('clients.tabHook') },
              { value: 'proxy', label: t('clients.tabProxy') },
              { value: 'manual', label: t('clients.tabManual') },
            ]}
          />
        </div>
        {/* Proxy-tab prerequisite: every proxy hook needs the inbound forward
            proxy (service env or launcher) — without it the takeover is dead
            on arrival, so say so BEFORE the setup button. */}
        {activeTab === 'proxy' && (fpEnabled === false || fpRunning === false || caTrust?.trusted === false) && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-amber) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-amber) 35%, transparent)', color: 'var(--accent-amber)', fontSize: 'var(--text-md)', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <X size={14} />
            <span style={{ flex: 1 }}>
              {t(
                fpEnabled === false
                  ? 'clients.fpPrereqOff'
                  : fpRunning === false
                    ? 'clients.fpPrereqDown'
                    : 'clients.warnCaNotTrusted',
                { path: caPath || '<appData>/forward-proxy/ca.pem' },
              )}
            </span>
            <Link
              to={fpEnabled === false || fpRunning === false ? '/proxy-access' : '/proxy-access?view=wizard'}
              style={{ color: 'var(--accent)', textDecoration: 'none', flexShrink: 0 }}
            >
              {t(fpEnabled === false || fpRunning === false ? 'nav.proxyAccess' : 'forwardProxy.helpTitle')} →
            </Link>
          </div>
        )}


        {/* Hook-tab roster filter: name / adapter id / config path substring. */}
        {activeTab === 'hook' && (
          <div style={{ position: 'relative', marginBottom: '12px' }}>
            <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('clients.filterPh')}
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px 7px 30px', borderRadius: '8px', border: '1px solid var(--card-border)', background: 'var(--well-bg)', color: 'var(--text-main)', fontSize: 'var(--text-md)' }}
            />
          </div>
        )}
        {/* Accordion: one full-width row per client — collapsed shows identity + status +
            quick action, expanding reveals the progressive setup form. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'stretch' }}>
          {clients.filter(c => activeTab === 'proxy'
            ? c.hookKind !== 'config'
            : activeTab === 'hook'
              && c.hookKind === 'config'
              && (!filter || [c.displayName, c.name, c.configPath].some(v => (v || '').toLowerCase().includes(filter.toLowerCase())))).map(c => {
            const open = expanded === c.name;
            // Folding the card away also dismisses its validation flag: the red
            // box belongs to the expanded form, not to the collapsed row.
            const toggle = () => {
              if (open) clearKeyError(c.name);
              setExpanded(prev => (prev === c.name ? null : c.name));
            };
            return (
              <div
                key={c.name}
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--card-border)',
                  borderRadius: '10px',
                  overflow: 'hidden',
                  flexShrink: 0,
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-base)', fontWeight: 'var(--font-bold)' }}>
                    <BrandIcon name={c.name === 'jetbrains-proxy' ? 'jetbrains' : c.name.replace(/-proxy$/, '')} size={18} />
                    {c.name === 'opencode-proxy' ? t('clients.nameOpencode') : c.displayName}
                  </span>
                  {c.products?.length ? (
                    // A family card has no single config file to show — the paths
                    // live in the per-product panels below.
                    <span style={{ flex: 1 }} />
                  ) : (
                    <span
                      title={c.configPath}
                      style={{ flex: 1, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {c.configPath}
                    </span>
                  )}
                  {/* Family card: how many products this machine actually has.
                      One row per product lives inside the expanded body. */}
                  {!!c.products && c.products.length > 1 && (
                    <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
                      {t('clients.jetbrainsProductCount', { n: c.products.length })}
                    </span>
                  )}
                  {/* Collapsed launcher row: the start command is the one thing
                      worth seeing without expanding — a plain double-click of
                      the app would silently stay un-proxied. Clicking the chip
                      copies; the row's own click (expand) is stopped. */}
                  {!open && c.hooked && c.hookKind === 'launcher' && LAUNCH_COMMANDS[c.name] && (
                    <code
                      role="button"
                      tabIndex={0}
                      title={t('clients.manualCopied')}
                      onClick={e => { e.stopPropagation(); void copyToClipboard(LAUNCH_COMMANDS[c.name].primary).then((ok) => ok && toast.success(t('clients.manualCopied'))); }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void copyToClipboard(LAUNCH_COMMANDS[c.name].primary).then((ok) => ok && toast.success(t('clients.manualCopied'))); } }}
                      style={{ flexShrink: 0, fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-main)', background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '6px', padding: '3px 8px', cursor: 'copy' }}
                    >
                      {LAUNCH_COMMANDS[c.name].primary}
                    </code>
                  )}
                  {c.hooked ? (
                    <span className="badge badge-success">{t(c.hookKind === 'launcher' ? 'clients.launcherHookedBadge' : 'overview.hooked')}</span>
                  ) : (
                    <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>
                      {t(c.hookKind === 'launcher' ? 'clients.launcherNotHookedBadge' : 'overview.notHooked')}
                    </span>
                  )}
                  {c.version && (
                    <span
                      className="badge"
                      title={c.version.meetsMin ? t('clients.versionOk') : t('clients.versionBelow', { min: c.version.min || '?' })}
                      style={
                        c.version.meetsMin
                          ? { background: 'var(--chip-bg)', color: 'var(--text-dim)', fontFamily: FONT_MONO, fontSize: 'var(--text-2xs)' }
                          : { background: 'color-mix(in srgb, var(--accent-amber) 15%, transparent)', color: 'var(--accent-amber)', fontFamily: FONT_MONO, fontSize: 'var(--text-2xs)' }
                      }
                    >
                      v{c.version.current}
                    </span>
                  )}
                  {!open && !c.products?.length && renderActionButtons(c, false)}
                </div>

                {open && (
                  <div style={{ padding: '16px 18px', borderTop: '1px solid var(--divider)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {/* Family products: NESTED collapsible panels. Every IDE is
                        taken over (and restored) on its own config root, its own
                        JBR truststore and its own ACP directory, so its files, its
                        trust state and its action live together — and the card
                        itself carries no setup/teardown: "the family" is not a
                        state that can be taken over, only its members are. */}
                    {!!c.products?.length && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {c.products.map(p => {
                          const key = `${c.name}:${p.id}`;
                          const panelOpen = !!openProducts[key];
                          const togglePanel = () => setOpenProducts(prev => ({ ...prev, [key]: !panelOpen }));
                          return (
                            <div key={p.id} style={{ border: '1px solid var(--card-border)', borderRadius: '10px', background: 'var(--well-bg)' }}>
                              <div
                                role="button"
                                tabIndex={0}
                                aria-expanded={panelOpen}
                                onClick={e => { e.stopPropagation(); togglePanel(); }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    togglePanel();
                                  }
                                }}
                                style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', cursor: 'pointer', userSelect: 'none' }}
                              >
                                <ChevronDown
                                  size={14}
                                  color="var(--text-dim)"
                                  style={{ flexShrink: 0, transition: 'transform 0.15s ease', transform: panelOpen ? 'rotate(180deg)' : 'none' }}
                                />
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', fontWeight: 'var(--font-bold)' }}>
                                  <BrandIcon name={p.id === 'intellij-idea' ? 'idea' : p.id} size={16} />
                                  {p.displayName}
                                </span>
                                {p.version && (
                                  <span style={{ flexShrink: 0, fontFamily: FONT_MONO, fontSize: 'var(--text-2xs)', color: 'var(--text-dim)' }}>{p.version}</span>
                                )}
                                {p.hooked ? (
                                  <span className="badge badge-success">{t('overview.hooked')}</span>
                                ) : (
                                  <span className="badge" style={{ background: 'var(--chip-bg)', color: 'var(--text-dim)' }}>{t('overview.notHooked')}</span>
                                )}
                              </div>
                              {panelOpen && (
                                <div style={{ borderTop: '1px solid var(--divider)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                                    {t('clients.configPath')}
                                    {/* The artifacts list already starts with the
                                        settings file; the raw path is the fallback
                                        for a product the IDE never ran. */}
                                    {p.artifacts.length ? p.artifacts.map(renderArtifact) : (
                                      <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', wordBreak: 'break-all', marginTop: '3px' }}>
                                        {p.configPath}
                                      </div>
                                    )}
                                  </div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                      {p.exists ? <Check size={12} color="var(--accent-emerald)" /> : <X size={12} color="var(--text-dim)" />}
                                      <span>{t('clients.fileExists')} {p.exists ? t('clients.yes') : t('clients.no')}</span>
                                    </span>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                      {p.caTrusted === true ? <Check size={12} color="var(--accent-emerald)" /> : <X size={12} color={p.caTrusted === false && p.hooked ? 'var(--accent-rose)' : 'var(--text-dim)'} />}
                                      {/* Trust is per IDE install (JBR reads its own cacerts,
                                          not the OS store), so an UNHOOKED IDE legitimately
                                          lacks the alias — setup imports it. A hooked IDE's
                                          absence is fixed by re-running setup for THAT
                                          product (idempotent); the proxy-access wizard's
                                          OS-store instructions would never reach JBR. */}
                                      {!p.hooked && p.caTrusted !== true ? (
                                        <span>{t('clients.jetbrainsCa')} {t('clients.jetbrainsCaNotHooked')}</span>
                                      ) : p.caTrusted === false ? (
                                        <>
                                          <span style={{ color: 'var(--accent-rose)' }}>{t('clients.jetbrainsCa')} {t('clients.jetbrainsCaAbsent')}</span>
                                          <button
                                            className="btn btn-sm"
                                            style={{ gap: '5px' }}
                                            disabled={loading}
                                            onClick={e => { e.stopPropagation(); void handleToggle(c.name, 'setup', p.id); }}
                                          >
                                            <RefreshCw size={11} />
                                            <span>{t('clients.jetbrainsCaReimport')}</span>
                                          </button>
                                        </>
                                      ) : (
                                        <span>
                                          {t('clients.jetbrainsCa')}{' '}
                                          {p.caTrusted === true ? t('clients.jetbrainsCaImported') : t('clients.jetbrainsCaUnknown')}
                                        </span>
                                      )}
                                    </span>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                      {p.junieVersion ? <Check size={12} color="var(--accent-emerald)" /> : <X size={12} color="var(--text-dim)" />}
                                      <span>{t('clients.jetbrainsJunie')} {p.junieVersion ?? t('clients.none')}</span>
                                    </span>
                                  </div>
                                  {/* Backup is reversible state, not a metric: only its
                                      ABSENCE under a live takeover is actionable — teardown
                                      could no longer restore the operator's own file. */}
                                  {p.hooked && !p.backupExists && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>
                                      <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                                      <span>{t('clients.backupMissingWarn')}</span>
                                    </div>
                                  )}
                                  <div style={{ display: 'flex', gap: '8px' }}>
                                    <button
                                      className={p.hooked ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm'}
                                      style={{ flex: 1 }}
                                      onClick={e => { e.stopPropagation(); handleToggle(c.name, p.hooked ? 'teardown' : 'setup', p.id); }}
                                      disabled={loading}
                                    >
                                      {p.hooked ? <Undo2 size={12} /> : <ArrowUpRight size={12} />}
                                      <span>{p.hooked ? t('clients.teardownBtn') : t('clients.setupBtn')}</span>
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {c.hookKind === 'launcher' ? (
                      // Launcher hooks own scripts, not a config file: every
                      // launcher setup writes is listed with its own existence
                      // mark (the CLI launcher only exists while the vendor CLI
                      // is installed).
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                        {t('clients.launcherPaths')}
                        {[{ path: c.configPath, exists: c.exists }, ...(c.artifacts ?? [])].map(renderArtifact)}
                      </div>
                    ) : c.products?.length ? null : (
                      <>
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                          {t('clients.configPath')}
                          <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', wordBreak: 'break-all', marginTop: '3px' }}>
                            {c.configPath}
                          </div>
                          {c.artifacts?.map(renderArtifact)}
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                          {c.exists ? <Check size={12} color="var(--accent-emerald)" /> : <X size={12} color="var(--text-dim)" />}
                          <span>{t('clients.fileExists')} {c.exists ? t('clients.yes') : t('clients.no')}</span>
                        </div>
                        {/* Same rule as the product rows: no backup metric, only the
                            anomaly that makes teardown unrecoverable. Config-rewrite
                            hooks only — launcher/service-env hooks never write a backup. */}
                        {c.hookKind === 'config' && c.hooked && !c.backupExists && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>
                            <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                            <span>{t('clients.backupMissingWarn')}</span>
                          </div>
                        )}
                        {c.name === 'workbuddy' && (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', borderLeft: '2px solid var(--accent)', paddingLeft: '10px' }}>
                            {t('clients.workbuddyHint')}
                          </div>
                        )}
                      </>
                    )}

                    {(c.hookKind !== 'config') && renderLaunchCommands(c)}

                    {(c.hookKind !== 'config') && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', borderLeft: '2px solid var(--accent)', paddingLeft: '10px' }}>
                        {/* Per-client hint, NEVER the shared one: `proxyHint` is
                            written for opencode's env-var hook and reads as
                            nonsense on a client that has no such hook. */}
                        {t(c.name === 'cursor-proxy' ? 'clients.cursorHint' : c.name === 'qoder-proxy' ? 'clients.qoderHint' : c.name === 'jetbrains-proxy' ? 'clients.jetbrainsHint' : 'clients.proxyHint', { caPath: caPath || '<appData>/forward-proxy/ca.pem' })}
                      </div>
                    )}

                    {renderGatewayCatalog(c)}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
                {(c.hookKind === 'config') && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '6px' }}>{t('clients.apiKey')}</div>
                    <Combobox
                      value={apiKeySel[c.name] || ''}
                      onChange={v => {
                        setApiKeySel(prev => ({ ...prev, [c.name]: v }));
                        clearKeyError(c.name);
                      }}
                      options={apiKeys.map(k => ({ value: k.key, label: k.name, meta: k.key.length > 12 ? `${k.key.slice(0, 8)}…${k.key.slice(-4)}` : undefined }))}
                      placeholder={t('clients.apiKeySelect')}
                      invalid={!!keyError[c.name]}
                      triggerRef={el => { keyPickerRefs.current[c.name] = el; }}
                    />
                    {!!keyError[c.name] && (
                      <div style={{ marginTop: '6px', fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>
                        {t('clients.apiKeyRequired')}
                      </div>
                    )}
                  </div>
                )}
                      {c.name === 'claude' && (
                  <div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '6px' }}>{t('clients.contextWindow')}</div>
                    <Combobox
                      value={ctxSel[c.name] || '262144'}
                      onChange={v => setCtxSel(prev => ({ ...prev, [c.name]: v }))}
                      options={ctxOptions}
                    />
                  </div>
                )}
                {clientSlots(c).filter(s => !isRoleTableClient(c.name) || s.key === 'main').map(s => (
                        <div key={s.key}>
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '6px' }}>
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
                            options={s.key === 'main' ? slotOptions(s) : [
                              // Secondary slots default to "not set": the value is
                              // only written when the user picks a concrete model.
                              { value: 'auto', label: t('clients.slotUnset') },
                              ...slotOptions(s).filter(o => o.value !== 'auto'),
                            ]}
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
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('clients.models')} <InfoTip text={t('clients.modelsInfo')} /></div>
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
                                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('clients.followNoKey')}</div>
                              )}
                              {!!fk && !followLoaded && (
                                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('clients.followLoading')}</div>
                              )}
                              {followLoaded && (
                                <>
                                  {renderModelChips(c.name, followList)}
                                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                                    {t('clients.followCount', { n: followList.length })} · {t('clients.followSnapshot')}
                                  </div>
                                </>
                              )}
                            </>
                          ) : mode === 'none' ? (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('clients.modelModeNoneHint')}</div>
                          ) : (
                            <>
                              {(() => {
                                // One wall, two sources: the virtual tier entries
                                // (adapter default block until edited) lead, concrete
                                // picks follow — mirroring the switcher's own order.
                                const merged = [...effectiveVirtualTiers(c.name), ...(extraSel[c.name] || [])];
                                if (merged.length === 0) return null;
                                return renderModelChips(
                                  c.name,
                                  merged,
                                  id => removeExtraModel(c.name, id),
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    style={{ fontSize: 'var(--text-xs)' }}
                                    onClick={() => clearExtraModels(c.name)}
                                    disabled={loading}
                                    title={t('clients.modelsClearHint')}
                                  >
                                    <Eraser size={11} />
                                    <span>{t('clients.modelsClear')}</span>
                                  </button>
                                );
                              })()}
                              <Combobox
                                multiple
                                value={[...effectiveVirtualTiers(c.name), ...(extraSel[c.name] || [])]}
                                onChange={next => applyModelDraft(c.name, next)}
                                options={extraOptions()}
                                placeholder={t('clients.addModel')}
                                panelMinWidth={360}
                              />
                            </>
                          )}
                          {isRoleTableClient(c.name) && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginTop: '8px' }}>
                              {t(c.name === 'pi' ? 'clients.piMetaHint' : 'clients.ompMetaHint')}
                            </div>
                          )}
                        </div>
                        );
                      })()}
                    </div>

                {isRoleTableClient(c.name) && (
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
                          style={{ flexShrink: 0, fontSize: 'var(--text-xs)' }}
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
                      hint={t(c.name === 'pi' ? 'clients.profileApplyHintPi' : 'clients.profileApplyHintOmp')}
                      label={t('clients.profileRowsLabel')}
                      on={linksOn[c.name]}
                      // Toggle is draft-only — the setup commit persists linksOn.
                      onToggle={v => setLinksOn(prev => ({ ...prev, [c.name]: v }))}
                      linkedCount={Object.keys(linkTagsOf(bindSel[c.name])).length}
                    />
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)', marginTop: '8px' }}>
                      {t(c.name === 'pi' ? 'clients.piMetaHint' : 'clients.ompMetaHint')}
                    </div>
                  </div>
                )}


                {c.name === 'opencode' && (
                  <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px' }}>
                    <ProfileLinkTable
                      rows={(agents || []).map(a => ({ name: a.name, mode: a.mode, current: a.model || a.effective }))}
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
                          style={{ flexShrink: 0, fontSize: 'var(--text-xs)' }}
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
                      // Toggle is draft-only — the setup commit persists linksOn.
                      onToggle={v => setLinksOn(prev => ({ ...prev, [c.name]: v }))}
                      linkedCount={Object.keys(linkTagsOf(bindSel[c.name])).length}
                      showSort
                    />
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px' }}>
                  {/* Family cards act per PRODUCT (nested panels) — a family-wide
                      setup/teardown button would claim a state that does not exist. */}
                  {!c.products?.length && renderActionButtons(c, true)}
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

          {/* Manual hookup guide: any client speaking the OpenAI or Anthropic wire
              protocol. Documentation + a live connectivity probe — no backend
              adapter, no status, no setup buttons. */}
          {activeTab === 'manual' && (
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px', background: 'var(--bg-elev)', border: '1px solid var(--card-border)', borderRadius: '10px', flexShrink: 0 }}>
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-relaxed)' }}>
              {t('clients.otherIntro')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)' }}>
              <div>{t('clients.otherStep1')}</div>
              <div>{t('clients.otherStep2')}</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
              {([
                { proto: t('clients.otherProtoOpenai'), base: `${gwBase}/v1`, endpoints: 'POST /v1/chat/completions · /v1/responses · /v1/models', auth: t('clients.otherOpenaiAuth') },
                { proto: t('clients.otherProtoAnthropic'), base: gwBase, endpoints: 'POST /v1/messages', auth: t('clients.otherAnthropicAuth') },
              ] as const).map(x => (
                <div key={x.proto} style={{ background: 'var(--well-bg)', border: '1px solid var(--card-border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{x.proto}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <code style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-sm)', color: 'var(--text-main)', wordBreak: 'break-all', flex: 1 }}>
                      {x.base}
                    </code>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ flexShrink: 0 }}
                      title={t('clients.manualCopied')}
                      onClick={() => {
                        void copyToClipboard(x.base).then((ok) =>
                          ok ? toast.success(t('clients.manualCopied')) : toast.error(t('common.failed')),
                        );
                      }}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {x.endpoints}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{x.auth}</div>
                </div>
              ))}
            </div>

            <div style={{ borderTop: '1px solid var(--divider)', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-relaxed)' }}>
                {t('clients.otherStep3')}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={manualKey}
                  onChange={e => setManualKey(e.target.value)}
                  placeholder={t('clients.manualKeyPh')}
                  style={{ flex: '1 1 220px', minWidth: 0, padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--card-border)', background: 'var(--well-bg)', color: 'var(--text-main)', fontSize: 'var(--text-sm)', fontFamily: FONT_MONO }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={manualTest?.state === 'running'}
                  onClick={async () => {
                    setManualTest({ state: 'running' });
                    try {
                      const res = await fetch(`${gwBase}/v1/models`, {
                        headers: manualKey
                          ? { Authorization: `Bearer ${manualKey}`, 'x-api-key': manualKey, 'anthropic-version': '2023-06-01' }
                          : {},
                      });
                      if (!res.ok) throw new Error(`HTTP ${res.status}`);
                      const body = await res.json();
                      const n = Array.isArray(body?.data) ? body.data.length : 0;
                      setManualTest({ state: 'ok', detail: String(n) });
                    } catch (err) {
                      setManualTest({ state: 'fail', detail: err instanceof Error ? err.message : String(err) });
                    }
                  }}
                >
                  <Activity size={12} />
                  <span>{t('clients.manualTest')}</span>
                </button>
              </div>
              {manualTest?.state === 'ok' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-sm)', color: 'var(--accent-emerald)' }}>
                  <Check size={14} />
                  <span>{t('clients.manualTestOk', { n: manualTest.detail || '0' })}</span>
                </div>
              )}
              {manualTest?.state === 'fail' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-sm)', color: 'var(--accent-amber)' }}>
                  <X size={14} />
                  <span>{t('clients.manualTestFail', { detail: manualTest.detail || '' })}</span>
                </div>
              )}
            </div>

            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', lineHeight: 'var(--leading-relaxed)' }}>
              {t('clients.otherMore')}{' '}
              <Link to="/api-keys" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                {t('nav.apiKeys')} →
              </Link>
            </div>
          </div>
          )}
        </div>
      </div>
      {advancedPlugin ? (
        <PluginConfigDrawer
          plugin={advancedPlugin}
          onClose={() => setAdvancedPlugin(null)}
          showClientsGuide={false}
        />
      ) : null}
    </div>
  );
};
