/**
 * Mihomo (Clash.Meta) core management — the second half of the outbound proxy
 * capability, split off ProxyPage once the mode/URL card stopped being the only
 * thing there. It owns the sidecar lifecycle, subscriptions, nodes, rules and
 * connectivity checks; the outbound endpoint selection itself stays on
 * ProxyPage, and the model-scoped patterns on ProxyPatternsPage.
 *
 * The three pages write the same `proxy:` section of the config file, so every
 * save re-reads the document and merges only the fields this page owns —
 * otherwise a node list saved here would resurrect a stale mode/URL (or the
 * reverse) from whichever page loaded first.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CheckCircle2, XCircle, Copy, ArrowDown, ArrowUp, ArrowUpDown, ArrowLeftRight, Cpu, Download, Link2, Loader2, Network, Play, Plus, RefreshCw, Rss, Save, ScrollText, SlidersHorizontal, Square, Trash2 } from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import { BrandIcon } from '../components/BrandIcons';
import { ProviderLogo } from '../components/ProviderLogo';
import { api, OcApiError, type MihomoGroupType, type MihomoManualNode, type MihomoManualNodeType, type MihomoNodeCatalog, type MihomoNodeSource, type MihomoProviderInfo, type MihomoProxyGroup, type MihomoProxyNode, type MihomoRoutingMode, type MihomoStatus, type MihomoRuleRow, type MihomoSubscription, type MihomoCustomRule, type MihomoRuleImportResult, type MihomoRuleTarget, type MihomoRuleType } from '../lib/api';
import { DEFAULT_MIHOMO_CONTROLLER_PORT, DEFAULT_MIHOMO_GROUP, DEFAULT_MIHOMO_GROUP_INTERVAL_SEC, DEFAULT_MIHOMO_GROUP_TOLERANCE_MS, DEFAULT_MIHOMO_MIXED_PORT, DEFAULT_MIHOMO_SUB_INTERVAL_SEC, DEFAULT_MIHOMO_TEST_URL, MIHOMO_GROUP_INTERVAL_MAX_SEC, MIHOMO_GROUP_INTERVAL_MIN_SEC, MIHOMO_GROUP_TOLERANCE_MAX_MS } from '../lib/defaults';
import { fmtDur, formatTimestamp } from '../lib/format';
import { delayColor, delayRank, pruneReadings, UNTESTED_DELAY, type DelayReading } from '../lib/delay';
import { copyToClipboard } from '../lib/clipboard';
import { useI18n } from '../i18n/I18nContext';
import { useToast } from '../components/ToastProvider';
import { useConfirm } from '../components/ConfirmProvider';
import { Switch } from '../components/Switch';
import { SegGroup } from '../components/SegGroup';
import { Combobox } from '../components/Combobox';
import { SearchInput } from '../components/SearchInput';
import { ScrollTable } from '../components/ScrollTable';
import { Dialog } from '../components/Dialog';

type ProxyMode = 'manual' | 'mihomo';
type Tab = 'general' | 'subscriptions' | 'nodes' | 'rules' | 'test';

/** One connectivity-check outcome, keyed by the probed URL in `urlProbes`. */
type UrlProbe = { state: 'testing' | 'ok' | 'fail'; ms?: number; node?: string; error?: string };

/** The Mihomo scope's sections, rendered as a vertical menu (a section switch
 *  is navigation, not a second tab strip under the page's own tabs). */
const SUB_TABS: { value: Tab; icon: React.ReactNode; labelKey: string }[] = [
  { value: 'general', icon: <SlidersHorizontal size={15} />, labelKey: 'proxy.tabGeneral' },
  { value: 'subscriptions', icon: <Rss size={15} />, labelKey: 'proxy.tabSubscriptions' },
  { value: 'nodes', icon: <Network size={15} />, labelKey: 'proxy.tabNodes' },
  { value: 'test', icon: <Activity size={15} />, labelKey: 'proxy.tabTest' },
  { value: 'rules', icon: <ScrollText size={15} />, labelKey: 'proxy.tabRules' },
];

/** Rule types the renderer can evaluate on its own (no geo data, no rule-set
 *  fetch). The backend drops anything outside this list, so the editor must not
 *  offer it either. */
const RULE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'DOMAIN', label: 'DOMAIN' },
  { value: 'DOMAIN-SUFFIX', label: 'DOMAIN-SUFFIX' },
  { value: 'DOMAIN-KEYWORD', label: 'DOMAIN-KEYWORD' },
  { value: 'IP-CIDR', label: 'IP-CIDR' },
  { value: 'IP-CIDR6', label: 'IP-CIDR6' },
  { value: 'DST-PORT', label: 'DST-PORT' },
  { value: 'SRC-PORT', label: 'SRC-PORT' },
  { value: 'PROCESS-NAME', label: 'PROCESS-NAME' },
  { value: 'PROCESS-PATH', label: 'PROCESS-PATH' },
];

const RULE_TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: 'PROXY', label: 'PROXY' },
  { value: 'DIRECT', label: 'DIRECT' },
  { value: 'REJECT', label: 'REJECT' },
];

/** Payload syntax differs per type; an example beats an empty box. */
const RULE_PAYLOADS: Record<string, string> = {
  DOMAIN: 'example.com',
  'DOMAIN-SUFFIX': 'example.com',
  'DOMAIN-KEYWORD': 'google',
  'IP-CIDR': '192.168.0.0/16',
  'IP-CIDR6': '2001:db8::/32',
  'DST-PORT': '443',
  'SRC-PORT': '1024-65535',
  'PROCESS-NAME': 'chrome.exe',
  'PROCESS-PATH': 'C:/Apps/app.exe',
};

interface ProxyShape {
  enabled?: boolean;
  mode?: ProxyMode;
  url?: string;
  includes?: string[];
  excludes?: string[];
  mihomo?: {
    /** Derived by the backend from `proxy.mode`; read-only here. */
    enabled?: boolean;
    /** Whether the core should be RUNNING — orthogonal to `mode`. Tri-state:
     *  absent = follow the mode (pre-split behaviour). */
    autoStart?: boolean;
    binaryPath?: string;
    mixedPort?: number;
    controllerPort?: number;
    controllerSecret?: string;
    subscriptions?: MihomoSubscription[];
    selectedGroup?: string;
    selectedNodes?: Record<string, string>;
    routingMode?: MihomoRoutingMode;
    groupType?: MihomoGroupType;
    groupInterval?: number;
    groupTolerance?: number;
    /** Health-check / delay-test URL; absent = the factory default. */
    testUrl?: string;
    /** Operator-authored rules, rendered ahead of the final MATCH. */
    rules?: MihomoCustomRule[];
    /** Hand-authored nodes written into the generated config (ADR-0022). */
    manualNodes?: MihomoManualNode[];
  };
}

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-dim)',
  marginBottom: '4px',
  display: 'block',
};

/** The custom-rule row grid, shared by its header and its edit rows so the two
 *  never drift apart. `minmax(0, 1fr)` — not `1fr` — for the payload cell: an
 *  `<input>` carries a browser min-width (~20 characters), which cannot shrink
 *  and used to push the move/delete buttons past the card's right edge. The
 *  action cell is `auto` so the three buttons always fit their own track. */
/** Filter value that groups every row without a provenance label. */
// The rules cards own their vertical rhythm: every child shares one centre line and
// the parent's flex gap supplies the space below the header, so `.card-header`'s
// own 12px trail (meant for cards whose body is not a flex column) is dropped.
// Every cell carries the head's own horizontal padding: the head row is a separate
// table, so a body cell without it shifts its content 10px away from the label above.
const RULE_CELL: React.CSSProperties = { padding: '6px 10px' };

const RULES_CARD_HEADER: React.CSSProperties = {
  marginBottom: 0,
  minHeight: 32,
  alignItems: 'center',
};
const MANUAL_RULE_SOURCE = '__manual__';
const SPIN: React.CSSProperties = { animation: 'ocr-spin 0.8s linear infinite' };

/** Candidate endpoints for the connectivity tab. Presets only — the field
 *  stays free text, because the right endpoint is whatever is reachable from
 *  BOTH this machine and the selected nodes. Google's two presets carry the
 *  official multicolor G (`google.color.svg`); Gemini keeps the provider glyph,
 *  which IS the Gemini sparkle. */
type EndpointMark = { kind: 'provider'; id: string } | { kind: 'brand'; name: string };
const TEST_URL_PRESETS: { label: string; url: string; logo: EndpointMark }[] = [
  { label: 'Google 204', url: DEFAULT_MIHOMO_TEST_URL, logo: { kind: 'brand', name: 'google' } },
  { label: 'Google', url: 'https://www.google.com', logo: { kind: 'brand', name: 'google' } },
  { label: 'Cloudflare 204', url: 'https://cp.cloudflare.com/generate_204', logo: { kind: 'provider', id: 'cloudflare-workers-ai' } },
  { label: 'OpenAI', url: 'https://api.openai.com/v1/models', logo: { kind: 'provider', id: 'openai' } },
  { label: 'Anthropic', url: 'https://api.anthropic.com/v1/models', logo: { kind: 'provider', id: 'anthropic' } },
  { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models', logo: { kind: 'provider', id: 'google' } },
];

/** Card subtitle: the host the probe will actually reach. */
const endpointHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Endpoint mark at one weight for both sources: ProviderLogo draws its own
 *  plate, so a colored brand icon gets the identical plate (a bare `img` would
 *  read as a different size in the same grid). */
const EndpointLogo: React.FC<{ mark: EndpointMark }> = ({ mark }) => {
  if (mark.kind === 'provider') return <ProviderLogo providerId={mark.id} logoMap={{}} size={ENDPOINT_LOGO_PX} />;
  return (
    <div
      style={{
        width: ENDPOINT_LOGO_PX,
        height: ENDPOINT_LOGO_PX,
        borderRadius: Math.max(6, Math.round(ENDPOINT_LOGO_PX * 0.28)),
        background: 'var(--logo-plate-bg)',
        border: '1px solid var(--card-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <BrandIcon name={mark.name} size={Math.round(ENDPOINT_LOGO_PX * 0.72)} fallback={null} />
    </div>
  );
};

/** Endpoint mark size: one constant so every card's plate stays identical. */
const ENDPOINT_LOGO_PX = 48;

/** Catalog projection: every wire whitelist comes from GET /nodes/catalog. */
const optionList = (values: string[] = []) => values.map(value => ({ value, label: value }));

/**
 * Form state for the manual-node dialog. Every protocol's modeled fields live
 * here; only the ones the selected type owns are rendered and submitted. A
 * YAML-authored row is projected into the same fields by the backend, so it
 * edits through this form too; the YAML tab remains for unmodeled keys.
 */
interface NodeDraft {
  id?: string;
  mode: 'form' | 'yaml';
  name: string;
  type: MihomoManualNodeType;
  server: string;
  port: string;
  cipher: string;
  password: string;
  uuid: string;
  alterId: string;
  vmessCipher: string;
  network: 'tcp' | 'ws' | 'grpc' | 'h2';
  yaml: string;
  /** Mapping keys the form cannot edit; shown so "N more keys" is explicit. */
  unmodeled: string[];
  tls: boolean;
  sni: string;
  flow: string;
  wsPath: string;
  wsHost: string;
  grpcServiceName: string;
  h2Host: string;
  h2Path: string;
  realityPublicKey: string;
  realityShortId: string;
  alpn: string;
  clientFingerprint: string;
  udp: boolean;
  tfo: boolean;
  ipVersion: string;
  plugin: string;
  pluginMode: string;
  pluginHost: string;
  pluginPath: string;
  pluginTls: boolean;
  obfs: string;
  obfsPassword: string;
  up: string;
  down: string;
  ports: string;
  skipCertVerify: boolean;
  username: string;
}

const emptyNodeDraft = (): NodeDraft => ({
  mode: 'form', yaml: '', unmodeled: [],
  name: '', type: 'ss', server: '', port: '443',
  cipher: 'chacha20-ietf-poly1305', password: '', uuid: '', alterId: '0',
  vmessCipher: 'auto', network: 'tcp', tls: true, sni: '', flow: '',
  wsPath: '/', wsHost: '', grpcServiceName: '', h2Host: '', h2Path: '/',
  realityPublicKey: '', realityShortId: '', alpn: '', clientFingerprint: 'chrome',
  udp: false, tfo: false, ipVersion: '',
  plugin: '', pluginMode: '', pluginHost: '', pluginPath: '', pluginTls: false,
  obfs: '', obfsPassword: '', up: '', down: '', ports: '',
  skipCertVerify: false, username: '',
});

const nodeToDraft = (node: MihomoManualNode): NodeDraft => {
  // A YAML-authored row has no typed columns; the backend projects its mapping
  // into `fields` so the form shows the same values the YAML tab holds.
  const source = { ...node, ...(node.fields ?? {}) };
  return {
    id: node.id,
    mode: 'form',
    yaml: node.yaml ?? '',
    unmodeled: node.unmodeled ?? [],
    name: source.name,
    // Unknown protocols still open the dialog; only identity is editable and
    // the component decides that from the catalog's protocol list.
    type: source.type as MihomoManualNodeType,
    server: source.server,
    port: String(source.port),
    cipher: source.cipher ?? 'chacha20-ietf-poly1305',
    password: source.password ?? '',
    uuid: source.uuid ?? '',
    alterId: String(source.alterId ?? 0),
    vmessCipher: source.vmessCipher ?? 'auto',
    network: source.network ?? 'tcp',
    tls: source.tls === true,
    sni: source.sni ?? '',
    flow: source.flow ?? '',
    wsPath: source.wsPath ?? '/',
    wsHost: source.wsHost ?? '',
    grpcServiceName: source.grpcServiceName ?? '',
    h2Host: source.h2Host ?? '',
    h2Path: source.h2Path ?? '/',
    realityPublicKey: source.realityPublicKey ?? '',
    realityShortId: source.realityShortId ?? '',
    alpn: (source.alpn ?? []).join(', '),
    clientFingerprint: source.clientFingerprint ?? 'chrome',
    udp: source.udp === true,
    tfo: source.tfo === true,
    ipVersion: source.ipVersion ?? '',
    plugin: source.plugin ?? '',
    pluginMode: source.pluginMode ?? '',
    pluginHost: source.pluginHost ?? '',
    pluginPath: source.pluginPath ?? '',
    pluginTls: source.pluginTls === true,
    obfs: source.obfs ?? '',
    obfsPassword: source.obfsPassword ?? '',
    up: source.up ?? '',
    down: source.down ?? '',
    ports: source.ports ?? '',
    skipCertVerify: source.skipCertVerify === true,
    username: source.username ?? '',
  };
};

/** Comma-separated ALPN input → the string list the API stores. */
const parseAlpn = (raw: string): string[] =>
  raw.split(',').map(item => item.trim()).filter(Boolean).slice(0, 8);

const alpnExtras = (draft: NodeDraft): Partial<MihomoManualNode> =>
  parseAlpn(draft.alpn).length ? { alpn: parseAlpn(draft.alpn) } : {};

const transportExtras = (draft: NodeDraft): Partial<MihomoManualNode> => ({
  ...(draft.network === 'ws'
    ? { wsPath: draft.wsPath.trim() || '/', ...(draft.wsHost.trim() ? { wsHost: draft.wsHost.trim() } : {}) }
    : {}),
  ...(draft.network === 'grpc' && draft.grpcServiceName.trim()
    ? { grpcServiceName: draft.grpcServiceName.trim() }
    : {}),
  ...(draft.network === 'h2'
    ? {
      h2Path: draft.h2Path.trim() || '/',
      ...(draft.h2Host.trim() ? { h2Host: draft.h2Host.trim() } : {}),
    }
    : {}),
});

const networkExtras = (draft: NodeDraft): Partial<MihomoManualNode> => ({
  ...(draft.tfo ? { tfo: true } : {}),
  ...(draft.ipVersion ? { ipVersion: draft.ipVersion } : {}),
});

/** The wire row for one draft: fields the selected protocol does not own are
 *  omitted, so switching type cannot silently carry a stale credential. */
function nodePayload(draft: NodeDraft): Omit<MihomoManualNode, 'id'> {
  const base = {
    name: draft.name.trim(),
    type: draft.type,
    server: draft.server.trim(),
    port: Number(draft.port),
  };
  if (draft.type === 'ss') {
    return {
      ...base,
      cipher: draft.cipher,
      password: draft.password,
      ...(draft.udp ? { udp: true } : {}),
      ...(draft.plugin ? {
        plugin: draft.plugin,
        ...(draft.pluginMode ? { pluginMode: draft.pluginMode } : {}),
        ...(draft.pluginHost.trim() ? { pluginHost: draft.pluginHost.trim() } : {}),
        ...(draft.pluginPath.trim() ? { pluginPath: draft.pluginPath.trim() } : {}),
        ...(draft.pluginTls ? { pluginTls: true } : {}),
      } : {}),
      ...networkExtras(draft),
    };
  }
  if (draft.type === 'vmess' || draft.type === 'vless') {
    return {
      ...base,
      uuid: draft.uuid.trim(),
      ...(draft.type === 'vmess' ? { alterId: Number(draft.alterId) || 0, vmessCipher: draft.vmessCipher } : {}),
      network: draft.network,
      tls: draft.tls,
      ...(draft.sni.trim() ? { sni: draft.sni.trim() } : {}),
      ...(draft.type === 'vless' && draft.flow.trim() ? { flow: draft.flow.trim() } : {}),
      ...(draft.type === 'vless' && draft.realityPublicKey.trim()
        ? {
          realityPublicKey: draft.realityPublicKey.trim(),
          ...(draft.realityShortId.trim() ? { realityShortId: draft.realityShortId.trim() } : {}),
        }
        : {}),
      ...transportExtras(draft),
      ...alpnExtras(draft),
      ...(draft.clientFingerprint ? { clientFingerprint: draft.clientFingerprint } : {}),
      ...(draft.skipCertVerify ? { skipCertVerify: true } : {}),
      ...(draft.udp ? { udp: true } : {}),
      ...networkExtras(draft),
    };
  }
  if (draft.type === 'trojan') {
    return {
      ...base,
      password: draft.password,
      network: draft.network,
      ...(draft.sni.trim() ? { sni: draft.sni.trim() } : {}),
      ...transportExtras(draft),
      skipCertVerify: draft.skipCertVerify,
      ...alpnExtras(draft),
      ...(draft.clientFingerprint ? { clientFingerprint: draft.clientFingerprint } : {}),
      ...(draft.udp ? { udp: true } : {}),
      ...networkExtras(draft),
    };
  }
  if (draft.type === 'hysteria2') {
    return {
      ...base,
      password: draft.password,
      ...(draft.sni.trim() ? { sni: draft.sni.trim() } : {}),
      skipCertVerify: draft.skipCertVerify,
      ...(draft.obfs === 'salamander'
        ? { obfs: 'salamander', ...(draft.obfsPassword.trim() ? { obfsPassword: draft.obfsPassword.trim() } : {}) }
        : {}),
      ...(draft.up.trim() ? { up: draft.up.trim() } : {}),
      ...(draft.down.trim() ? { down: draft.down.trim() } : {}),
      ...(draft.ports.trim() ? { ports: draft.ports.trim() } : {}),
      ...(draft.ipVersion ? { ipVersion: draft.ipVersion } : {}),
      ...alpnExtras(draft),
    };
  }
  return {
    ...base,
    ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    tls: draft.tls,
    skipCertVerify: draft.skipCertVerify,
    ...(draft.udp ? { udp: true } : {}),
    ...networkExtras(draft),
  };
}

/** Identity fields every node needs, form or YAML. */
function nodeIdentityValid(draft: NodeDraft): boolean {
  const port = Number(draft.port);
  return Boolean(draft.name.trim()) && Boolean(draft.server.trim()) && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Required fields per protocol: the backend drops the row silently otherwise,
 *  so the dialog refuses to submit an incomplete one. */
function nodeDraftValid(draft: NodeDraft): boolean {
  if (!nodeIdentityValid(draft)) return false;
  if (draft.type === 'ss') return Boolean(draft.cipher && draft.password);
  if (draft.type === 'vmess' || draft.type === 'vless') return Boolean(draft.uuid.trim());
  if (draft.type === 'trojan' || draft.type === 'hysteria2') return Boolean(draft.password);
  return true;
}

/** Header of one `.sub-card` block on the general tab: icon + label, so every
 *  section reads at the same weight instead of the old flat run of fields. */
const sectionTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: 'var(--text-md)',
  fontWeight: 'var(--font-bold)',
};

/** Backend mihomo codes → localized copy. The sidecar/binary layers speak
 *  English codes; the console never shows their raw message. */
const CORE_ERROR_KEYS: Record<string, string> = {
  'not-running': 'proxy.notRunning',
  timeout: 'proxy.nodeTestTimeout',
  disabled: 'proxy.errDisabled',
  'port-collision': 'proxy.errPortCollision',
  'import-failed': 'proxy.errImport',
  'binary-missing': 'proxy.errBinaryMissing',
  'spawn-failed': 'proxy.errStart',
  'reload-failed': 'proxy.errReload',
  'release-lookup-failed': 'proxy.errInstall',
  'download-failed': 'proxy.errInstall',
  'download-too-large': 'proxy.errInstall',
  'asset-missing': 'proxy.errUnsupported',
  'unsupported-platform': 'proxy.errUnsupported',
  'unpack-failed': 'proxy.errUnpack',
  // Lifecycle failures the sidecar reports as a plain result. Without these the
  // toast would print the backend's English diagnostic instead of localized copy.
  'not-ready': 'proxy.errNotReady',
  'spawn-exited': 'proxy.errSpawnExited',
  'kill-failed': 'proxy.errKillFailed',
  'pid-unknown': 'proxy.errPidUnknown',
  unauthorized: 'proxy.errUnauthorized',
  'node-not-found': 'proxy.nodeNotFound',
  'no-node': 'proxy.nodeNone',
};

/** Stable filter key for a node origin: subscriptions are keyed by their id,
 *  manual/built-in rows by their kind. */
function nodeSourceKey(source: MihomoNodeSource): string {
  return source.kind === 'subscription' ? `sub:${source.id ?? ''}` : source.kind;
}

export const MihomoPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [proxy, setProxy] = useState<ProxyShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Landing tab: the core card. On a dedicated page the first question is "is
  // the core up, and what is it doing", not "show me the rule table".
  const [tab, setTab] = useState<Tab>('general');
  const [status, setStatus] = useState<MihomoStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Live install download progress. `total` is 0 when the host sends no
   *  Content-Length, in which case the label falls back to a byte count. */
  const [installProgress, setInstallProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [subs, setSubs] = useState<MihomoSubscription[]>([]);
  const [providers, setProviders] = useState<MihomoProviderInfo[]>([]);
  const [groups, setGroups] = useState<MihomoProxyGroup[]>([]);
  const [nodes, setNodes] = useState<MihomoProxyNode[]>([]);
  const [rules, setRules] = useState<MihomoRuleRow[]>([]);
  /** Latency readings produced by THIS console, keyed by node name. The
   *  controller snapshot only carries provider history; "testing", "timeout"
   *  and "error" exist nowhere else, and folding them into `node.delay` would
   *  let a sentinel masquerade as a measurement. */
  const [delayReadings, setDelayReadings] = useState<Record<string, DelayReading>>({});
  const [group, setGroup] = useState(DEFAULT_MIHOMO_GROUP);
  const [query, setQuery] = useState('');
  const [delaySort, setDelaySort] = useState<'none' | 'asc' | 'desc'>('none');
  /** '' = every source. A mixed selector group draws nodes from several
   *  subscriptions plus the manual list, and "show me only this source" is the
   *  useful cut; `manual` and `sub:<id>` are the stable keys. */
  const [sourceFilter, setSourceFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [groupType, setGroupType] = useState<MihomoGroupType>('select');
  /** The add form only ever creates: editing a row opens `editSub` as a dialog,
   *  so a half-filled add form can never be mistaken for an edit in progress. */
  const [newSub, setNewSub] = useState({ name: '', url: '', interval: String(DEFAULT_MIHOMO_SUB_INTERVAL_SEC) });
  const [editSub, setEditSub] = useState<{ id: string; name: string; url: string; interval: string; enabled: boolean } | null>(null);
  /** The PAC URL is reference copy, not a field: it opens in a dialog so the
   *  general tab does not carry a permanently read-only input. */
  const [pacOpen, setPacOpen] = useState(false);
  /** Manual-node dialog: null = closed. Its own busy flag keeps the dialog
   *  locked while the core reconciles, without disabling unrelated controls. */
  const [nodeDialog, setNodeDialog] = useState<NodeDraft | null>(null);
  const [nodeCatalog, setNodeCatalog] = useState<MihomoNodeCatalog | null>(null);
  const [nodeFieldError, setNodeFieldError] = useState<{ field?: string; message: string } | null>(null);
  const [nodeBusy, setNodeBusy] = useState(false);
  /** Last unsaved-node probe result; cleared on every field edit so a stale
   *  "reachable" never describes a different server. */
  const [nodeTest, setNodeTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; ms?: number; error?: string }>({ state: 'idle' });
  /** Connectivity-check results keyed by URL: the check runs THROUGH the
   *  selected proxy node, so it proves tunnel + endpoint together. Keyed (not
   *  pass before choosing one as the configured test URL. */
  const [urlProbes, setUrlProbes] = useState<Record<string, UrlProbe>>({});
  const [urlBatch, setUrlBatch] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 });
  /** Ad-hoc endpoint typed on the connectivity section. It is a probe target,
   *  not a second copy of the config field: only "use as test URL" writes. */
  const [customTestUrl, setCustomTestUrl] = useState('');
  /** True while a routing-mode write is in flight: the selector already shows
   *  the requested mode (optimistic), so the mismatch banner — which compares
   *  that baseline against the LAST live snapshot — would flash "LIVE: <old>"
   *  for the two controller round-trips the write needs. A change the operator
   *  just made is not a deviation; suppress the banner until the snapshot is
   *  refreshed, then let a real mismatch (core refused / another client won)
   *  show again. */
  const [routingPending, setRoutingPending] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.getMihomoStatus());
    } catch {
      // The card shows the last known status; a blip must not clear it.
    }
  }, []);

  const refreshSubs = useCallback(async () => {
    const body = await api.getMihomoSubscriptions();
    const list = body.subscriptions || [];
    setSubs(list);
    setProviders(body.providers || []);
    return list;
  }, []);


  const refreshNodes = useCallback(async (forGroup?: string) => {
    // Always asked with the group on screen: the server resolves each member's
    // type/delay from the live controller snapshot, so a group the console
    // merely switched to must be requested, not re-mapped from another group's
    // node list (that remap is what produced rows typed "Unknown").
    const body = await api.getMihomoProxies(forGroup);
    setGroups(body.groups || []);
    setNodes(body.nodes || []);
    // Console readings age out like Clash Verge's delay cache: after 30 minutes
    // the number no longer describes the node, so a cell must not keep it.
    setDelayReadings(prev => pruneReadings(prev));
    // The RUNNING group's kind, not the saved config: the console may only pick
    // a node while mihomo is in `select` mode.
    setGroupType(body.groupType ?? 'select');
    if (body.group) setGroup(body.group);
    // A filter that no longer matches anything in the new group would hide every
    // row and look like an empty group; drop it instead.
    setSourceFilter(prev => (prev && (body.nodes || []).some(node => nodeSourceKey(node.source) === prev) ? prev : ''));
  }, []);

  /** A failed fetch and an empty table are different facts: an unreachable
   *  controller used to render as "no rules", which reads as "this config has
   *  no rules" — the opposite of the truth. Keep the reason and show it. */
  const [rulesError, setRulesError] = useState<string | null>(null);
  const refreshRules = useCallback(async () => {
    try {
      setRules(await api.getMihomoRules());
      setRulesError(null);
    } catch (err: any) {
      setRules([]);
      setRulesError(err?.message ? String(err.message) : String(err));
      throw err;
    }
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
    if (tab === 'nodes') {
      void refreshNodes().catch(toastFailure);
      void ensureNodeCatalog();
    }
    if (tab === 'rules') void refreshRules().catch(toastFailure);
  }, [tab, refreshSubs, refreshNodes, refreshRules]);

  const mihomo = proxy?.mihomo ?? {};
  const mode: ProxyMode = proxy?.mode === 'mihomo' ? 'mihomo' : 'manual';
  /** Controller-backed actions need a live core; without one the API answers 409.
   * Keep the buttons clickable: explain and send the operator to the core card. */
  const coreReady = status?.running === true;

  // The header pill names the live node on EVERY scope, so the node list is
  // fetched once as soon as a core is running — not only when the nodes tab is
  // opened. An offline core has nothing to report and is not polled.
  useEffect(() => {
    if (!coreReady || nodes.length > 0) return;
    void refreshNodes().catch(() => {});
  }, [coreReady, nodes.length, refreshNodes]);

  /** Land on the core card: the Mihomo scope's basic-settings tab. */
  const showCoreCard = () => {
    setTab('general');
    requestAnimationFrame(() => {
      document.getElementById('mihomo-core-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const requireCore = (): boolean => {
    if (coreReady) return true;
    toast.error(t('proxy.notRunning'));
    showCoreCard();
    return false;
  };

  /** A 409 `not-running` means the core is down, not that the request failed. */
  const toastFailure = (err: unknown) => {
    const code = err instanceof OcApiError ? err.reasonCode : undefined;
    const key = code ? CORE_ERROR_KEYS[code] : undefined;
    if (key) {
      toast.error(t(key));
      if (code === 'not-running') showCoreCard();
      return;
    }
    toast.error(`${t('common.failed')}: ${(err as any)?.message || err}`);
  };

  /** Failed core/install operation (plain result, not a thrown error). */
  const toastResultFailure = (result: { error?: string | null; code?: string | null }) => {
    const key = result.code ? CORE_ERROR_KEYS[result.code] : undefined;
    toast.error(key ? t(key) : (result.error || t('proxy.notRunning')));
  };

  /** Where a client should fetch the PAC from: this gateway's own origin, so a
      console opened on another host/port still hands out a reachable URL. */
  const pacUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/proxy.pac`;

  /** Outbound mode changes apply to the LIVE core (no restart) and persist. */
  const changeRoutingMode = async (mode: MihomoRoutingMode) => {
    const previous = proxy?.mihomo?.routingMode ?? 'rule';
    patchMihomo({ routingMode: mode });
    setRoutingPending(true);
    try {
      const result = await api.setMihomoRoutingMode(mode);
      if (result.routingMode) patchMihomo({ routingMode: result.routingMode });
      await refreshStatus();
      if (result.warning) toast.error(t('proxy.routingNotApplied'));
    } catch (err) {
      patchMihomo({ routingMode: previous });
      toastFailure(err);
    } finally {
      setRoutingPending(false);
    }
  };

  const copyPac = async () => {
    // The shared helper, not `navigator.clipboard`: inside the desktop shell the
    // console is a remote page in a webview, where the engine's clipboard API
    // prompts and rejects on an unfocused document.
    if (await copyToClipboard(pacUrl)) toast.success(t('common.copied'));
    else toast.error(t('common.failed'));
  };

  /** Baseline key for the unsaved badge. `mihomo.enabled` is excluded: the
   *  backend derives it from `proxy.mode`, so it is not an edit made here. */
  const mihomoKey = (p: ProxyShape) => {
    const draft: Record<string, unknown> = { ...(p.mihomo || {}) };
    delete draft.enabled;
    return JSON.stringify(draft);
  };

  const patchMihomo = (partial: NonNullable<ProxyShape['mihomo']>) => setProxy(prev => ({
    ...(prev || {}),
    mihomo: { ...(prev?.mihomo || {}), ...partial },
  }));

  /**
   * The slice of `proxy` this page owns. `mode`, `enabled` and `url` belong to
   * ProxyPage and are never rewritten here. `mihomo.enabled` is a backend
   * derivation of the mode, so it is dropped too — writing it back would just
   * restate a value this page does not own.
   */
  const mihomoDraft = (): NonNullable<ProxyShape['mihomo']> => {
    const draft: NonNullable<ProxyShape['mihomo']> = { ...mihomo };
    delete draft.enabled;
    return draft;
  };

  const draftKey = JSON.stringify(mihomoDraft());
  // Baseline for the "unsaved" badge: captured once after the first load and
  // refreshed after every successful write. Node selection counts too — the file
  // on disk really does differ until a save lands.
  const [savedKey, setSavedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!proxy) return;
    setSavedKey(prev => prev ?? JSON.stringify(mihomoDraft()));
  }, [proxy]);
  const dirty = savedKey !== null && savedKey !== draftKey;

  /**
   * Merge-on-write. Three pages share one `proxy:` section, so a save here must
   * re-read the document first: writing this page's load-time snapshot would
   * roll back a mode/URL change made on ProxyPage (or patterns edited on
   * ProxyPatternsPage) since the console opened. Returns the section as written
   * so the caller can adopt it as the new baseline.
   */
  const persistMihomo = async (): Promise<ProxyShape> => {
    const cfg = await api.getConfig();
    const latest = (cfg.proxy || {}) as ProxyShape;
    const next: ProxyShape = {
      ...latest,
      mihomo: { ...(latest.mihomo || {}), ...mihomoDraft() },
    };
    await api.saveConfig({ proxy: next });
    return next;
  };

  const handleSave = async () => {
    if (!proxy) return;
    setSaving(true);
    try {
      const next = await persistMihomo();
      setProxy(next);
      setSavedKey(mihomoKey(next));
      toast.success(t('proxy.savedNotice'));
      void refreshStatus();
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setSaving(false);
    }
  };

  // Operator-authored rules. Kept separate from the live table below: this is
  // the DRAFT the console writes into the generated config, the table is what
  // the running core actually loaded.
  const [customRules, setCustomRules] = useState<MihomoCustomRule[]>([]);
  const [customRulesDirty, setCustomRulesDirty] = useState(false);
  const [customRulesSynced, setCustomRulesSynced] = useState(false);
  /** Batch selection: row indices in the draft. Cleared whenever rows move. */
  const [ruleSel, setRuleSel] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<'subscription' | 'text'>('subscription');
  const [importSubId, setImportSubId] = useState('');
  const [importText, setImportText] = useState('');
  const [importMap, setImportMap] = useState(true);
  const [importResult, setImportResult] = useState<MihomoRuleImportResult | null>(null);
  /** Rows the operator ticked in the preview. Import is two-phase on purpose:
   *  parsing is cheap, but moving traffic is not — nothing lands in the draft
   *  until the list on screen has been agreed to. */
  const [importPicked, setImportPicked] = useState<Set<number>>(new Set());
  /** The rules section has TWO views that never render together: the editable
   *  draft and the read-only table of what the core actually loaded. Mixing them
   *  on one screen made the operator guess which rows were in force. */
  const [rulesView, setRulesView] = useState<'edit' | 'live'>('live');
  /** Bucket used for rows that carry no provenance label. */
  const [ruleSourceFilter, setRuleSourceFilter] = useState('');
  /** Preview filter: a 200-row import is a haystack, not a list. */
  const [importFilter, setImportFilter] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  useEffect(() => {
    if (!proxy || customRulesSynced) return;
    setCustomRules(proxy.mihomo?.rules ?? []);
    setCustomRulesSynced(true);
  }, [proxy, customRulesSynced]);

  const editRule = (index: number, patch: Partial<MihomoCustomRule>) => {
    setCustomRules(prev => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
    setCustomRulesDirty(true);
  };

  const addRule = () => {
    setCustomRules(prev => [...prev, { type: 'DOMAIN-SUFFIX' as MihomoRuleType, payload: '', target: 'PROXY' as MihomoRuleTarget }]);
    setCustomRulesDirty(true);
  };

  const removeRule = (index: number) => {
    setCustomRules(prev => prev.filter((_, i) => i !== index));
    setCustomRulesDirty(true);
  };

  /** Order is the semantics: earlier rules win, so moving a row changes routing. */
  const moveRule = (index: number, delta: number) => {
    setCustomRules(prev => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setCustomRulesDirty(true);
  };

  const saveCustomRules = async () => {
    setBusy('rules');
    try {
      const result = await api.setMihomoCustomRules(customRules);
      const savedRules = result.rules ?? customRules;
      setCustomRules(savedRules);
      setCustomRulesDirty(false);
      // The rule write is a whole-list PUT that persists server-side; keep the
      // page's `proxy` copy in step, or the next general save (which rewrites
      // the whole proxy section) would quietly restore the old rule table.
      if (proxy) {
        const nextProxy: ProxyShape = { ...proxy, mihomo: { ...mihomo, rules: savedRules } };
        setProxy(nextProxy);
        if (!dirty) {
          setSavedKey(mihomoKey(nextProxy));
        }
      }
      toast.success(t('proxy.rulesApply'));
      await refreshStatus();
      await refreshRules().catch(() => {});
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const customRulesValid = customRules.every(rule => rule.payload.trim().length > 0);

  const toggleRuleSel = (index: number) => {
    setRuleSel(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /** Provenance labels present in the draft, with row counts ('' = all). */
  const ruleSourceOptions = (() => {
    const counts = new Map<string, number>();
    let unlabelled = 0;
    for (const rule of customRules) {
      const label = rule.source?.trim();
      if (!label) unlabelled += 1;
      else counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: value, meta: String(count) }));
    if (unlabelled > 0) rows.push({ value: MANUAL_RULE_SOURCE, label: t('proxy.rulesSourceManual'), meta: String(unlabelled) });
    return rows;
  })();

  /** Rows the operator can see right now — selection and select-all follow the
   *  filter, so "clean up by source" is one tick plus delete. */
  const ruleRows = customRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => !ruleSourceFilter || (rule.source?.trim() || MANUAL_RULE_SOURCE) === ruleSourceFilter);
  const visibleRuleIndexes = ruleRows.map(row => row.index);

  const allRulesSelected = visibleRuleIndexes.length > 0 && visibleRuleIndexes.every(index => ruleSel.has(index));
  const toggleAllRules = () => {
    setRuleSel(allRulesSelected ? new Set() : new Set(visibleRuleIndexes));
  };

  /** Batch target rewrite — the reason a multi-select matters after an import. */
  const batchSetTarget = (target: MihomoRuleTarget) => {
    setCustomRules(prev => prev.map((rule, index) => (ruleSel.has(index) ? { ...rule, target } : rule)));
    setCustomRulesDirty(true);
  };

  const batchRemove = () => {
    setCustomRules(prev => prev.filter((_, index) => !ruleSel.has(index)));
    setRuleSel(new Set());
    setCustomRulesDirty(true);
  };

  /** Moving a contiguous block keeps the selected rows together; the indices are
   *  walked in the direction of travel so no row is shifted twice. */
  const batchMove = (delta: number) => {
    setCustomRules(prev => {
      const next = [...prev];
      const ordered = [...ruleSel].sort((a, b) => (delta < 0 ? a - b : b - a));
      for (const index of ordered) {
        const target = index + delta;
        if (target < 0 || target >= next.length) continue;
        [next[index], next[target]] = [next[target], next[index]];
      }
      return next;
    });
    setRuleSel(new Set());
    setCustomRulesDirty(true);
  };

  const runImport = async () => {
    setImportBusy(true);
    try {
      const result = await api.importMihomoRules({
        source: importSource,
        subscriptionId: importSource === 'subscription' ? importSubId : undefined,
        text: importSource === 'text' ? importText : undefined,
        mapUnknownTarget: importMap,
      });
      setImportResult(result);
      // Preview first: every parsed row starts ticked, and the operator unticks
      // what should stay out. No merge happens here.
      setImportPicked(new Set(result.rules.map((_, index) => index)));
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setImportBusy(false);
    }
  };

  const importPreview = importResult?.rules ?? [];
  const importQuery = importFilter.trim().toLowerCase();
  /** Indices into `importPreview` (the checkbox set is indexed by the FULL list,
   *  so filtering never drops a tick the operator already made). */
  const importVisible = importPreview
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => !importQuery
      || rule.payload.toLowerCase().includes(importQuery)
      || rule.type.toLowerCase().includes(importQuery)
      || rule.target.toLowerCase().includes(importQuery));

  const toggleImportPick = (index: number) => {
    setImportPicked(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /** Merge ONLY the ticked rows into the draft. Duplicates of rows already in the
   *  list are skipped (an import must be idempotent — re-importing is normal). */
  const commitImport = () => {
    const picked = importPreview.filter((_, index) => importPicked.has(index));
    if (picked.length === 0) return;
    const seen = new Set(customRules.map(rule => `${rule.type}|${rule.payload}|${rule.target}`));
    const merged = [...customRules];
    let added = 0;
    for (const rule of picked) {
      const key = `${rule.type}|${rule.payload}|${rule.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(rule);
      added += 1;
    }
    setCustomRules(merged);
    if (added > 0) setCustomRulesDirty(true);
    toast.success(t('proxy.rulesImportAdded', { n: added }));
    setImportOpen(false);
    setImportResult(null);
    setImportPicked(new Set());
  };

  /**
   * Adopt the run policy the server just persisted. The start/stop routes write
   * `mihomo.autoStart` themselves (that is what makes the intent survive the
   * next unrelated config save), so the local copy is stale right after a click.
   * Only that one field is pulled back — a draft typed but not saved stays.
   */
  const adoptAutoStart = async () => {
    try {
      const cfg = await api.getConfig();
      const value = ((cfg.proxy || {}) as ProxyShape).mihomo?.autoStart;
      if (value === undefined) return;
      patchMihomo({ autoStart: value });
      // Rewriting the baseline too: this write came from the server, not from an
      // unsaved edit, so the badge must not light up because of it.
      setSavedKey(JSON.stringify({ ...mihomoDraft(), autoStart: value }));
    } catch {
      // The status pill already answers whether the core is up; a failed config
      // read here only costs the toggle its precision until the next refresh.
    }
  };

  /**
   * Run policy, persisted the moment it is flipped — unlike the rest of this
   * card, which is a draft until Save. The point of the switch is to change what
   * happens at boot, so leaving it as an unsaved draft would be misleading.
   */
  const setAutoStart = async (value: boolean) => {
    setBusy('autoStart');
    try {
      const cfg = await api.getConfig();
      const latest = (cfg.proxy || {}) as ProxyShape;
      const next: ProxyShape = {
        ...latest,
        // The draft rides along: this is a save, and silently dropping typed but
        // unsaved fields would be a worse surprise than committing them.
        mihomo: { ...(latest.mihomo || {}), ...mihomoDraft(), autoStart: value },
      };
      await api.saveConfig({ proxy: next });
      setProxy(next);
      setSavedKey(mihomoKey(next));
      await refreshStatus();
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const runCore = async (action: 'start' | 'stop' | 'restart' | 'install') => {
    setBusy(action);
    if (action === 'install') setInstallProgress(null);
    try {
      if (action !== 'install' && proxy) {
        const next = await persistMihomo();
        setProxy(next);
        setSavedKey(mihomoKey(next));
      }
      const result = action === 'start' ? await api.startMihomo()
        : action === 'stop' ? await api.stopMihomo()
        : action === 'restart' ? await api.restartMihomo()
        : await api.installMihomo((downloaded, total) => setInstallProgress({ downloaded, total }));
      if (result.ok === false || result.status === 'error') {
        toastResultFailure(result);
      } else {
        toast.success(action === 'install' ? t('proxy.installed') : t('proxy.savedNotice'));
      }
      await refreshStatus();
      if (action !== 'install') await adoptAutoStart();
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
      setInstallProgress(null);
    }
  };

  /** Install button label: percentage while the size is known, MB otherwise. */
  const installLabel = (): string => {
    if (busy !== 'install') return status?.installed ? t('proxy.reinstall') : t('proxy.install');
    if (!installProgress) return t('proxy.installing');
    if (installProgress.total > 0) {
      const pct = Math.min(100, Math.floor((installProgress.downloaded / installProgress.total) * 100));
      return t('proxy.installingPct', { pct });
    }
    return t('proxy.installingSize', { mb: (installProgress.downloaded / 1048576).toFixed(1) });
  };

  /** Add form: always creates and always enabled. The enable state is a row
   *  property (see `toggleSub`), never a field of the create form. */
  const addSub = async () => {
    const interval = Number(newSub.interval);
    setBusy('sub');
    try {
      await api.addMihomoSubscription({
        name: newSub.name.trim(),
        url: newSub.url.trim(),
        interval: Number.isFinite(interval) ? interval : DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
        enabled: true,
      });
      setNewSub({ name: '', url: '', interval: String(DEFAULT_MIHOMO_SUB_INTERVAL_SEC) });
      commitSubs(await refreshSubs());
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const saveSubEdit = async () => {
    if (!editSub) return;
    const interval = Number(editSub.interval);
    setBusy('sub');
    try {
      await api.updateMihomoSubscription(editSub.id, {
        name: editSub.name.trim(),
        url: editSub.url.trim(),
        interval: Number.isFinite(interval) ? interval : DEFAULT_MIHOMO_SUB_INTERVAL_SEC,
        enabled: editSub.enabled,
      });
      setEditSub(null);
      commitSubs(await refreshSubs());
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  /** Per-row enable/disable: a one-click state flip, not a form edit. Applied
   *  optimistically because a refresh round-trip on a slow core makes a plain
   *  toggle feel broken; the previous value is restored if the write fails. */
  const toggleSub = async (sub: MihomoSubscription, enabled: boolean) => {
    const previous = sub.enabled !== false;
    setSubs(prev => prev.map(item => (item.id === sub.id ? { ...item, enabled } : item)));
    setBusy(`toggle:${sub.id}`);
    try {
      const result = await api.updateMihomoSubscription(sub.id, { enabled });
      if (result.status === 'error') {
        setSubs(prev => prev.map(item => (item.id === sub.id ? { ...item, enabled: previous } : item)));
        toast.error(result.message || t('common.failed'));
        return;
      }
      commitSubs(await refreshSubs());
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      setSubs(prev => prev.map(item => (item.id === sub.id ? { ...item, enabled: previous } : item)));
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const removeSub = async (sub: MihomoSubscription) => {
    const ok = await confirm({ title: t('proxy.subDelete'), description: sub.name, danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await api.deleteMihomoSubscription(sub.id);
      commitSubs(await refreshSubs());
    } catch (err: any) {
      toastFailure(err);
    }
  };

  /** Keep the page's `proxy` copy of the subscription list in step with what the
   *  server just wrote: a general save (and the implicit save before start /
   *  stop / restart) rewrites the whole proxy section, so a stale copy would
   *  silently undo the subscription mutation. Rebaseline the unsaved badge only
   *  when the page was clean — a subscription write never persisted other edits. */
  const commitSubs = (next: MihomoSubscription[]) => {
    setSubs(next);
    if (!proxy) return;
    const nextProxy: ProxyShape = { ...proxy, mihomo: { ...mihomo, subscriptions: next } };
    setProxy(nextProxy);
    if (!dirty) {
      setSavedKey(mihomoKey(nextProxy));
    }
  };

  /** Persist the local manual-node list after a server write. Rebaseline the
   *  unsaved badge ONLY when the page was clean: unrelated unsaved edits must
   *  stay flagged, and the node write did not persist them. */
  const commitManualNodes = (next: MihomoManualNode[], selectedNodes?: Record<string, string>) => {
    const nextProxy: ProxyShape = {
      ...(proxy || {}),
      mihomo: { ...mihomo, manualNodes: next, ...(selectedNodes ? { selectedNodes } : {}) },
    };
    setProxy(nextProxy);
    if (!dirty) {
      setSavedKey(mihomoKey(nextProxy));
    }
  };

  /** A raw row whose protocol the typed whitelist does not support (tuic,
   *  wireguard, …) keeps its identity-only form: the form cannot model it. */
  const rawNodeForm = Boolean(nodeDialog?.id && nodeDialog.yaml)
    && !(nodeCatalog?.protocols ?? []).includes(nodeDialog?.type ?? '');

  const saveNode = async () => {
    if (!nodeDialog) return;
    setNodeBusy(true);
    try {
      // A YAML-authored row for a supported protocol sends the same modeled
      // fields the form shows; the backend overlays exactly those onto the
      // stored mapping, so unmodeled keys stay untouched. An unsupported
      // protocol sends identity only — the form never saw its options.
      const body = nodeDialog.mode === 'yaml'
        ? { yaml: nodeDialog.yaml }
        : rawNodeForm
          ? { name: nodeDialog.name.trim(), server: nodeDialog.server.trim(), port: Number(nodeDialog.port) }
          : nodePayload(nodeDialog);
      const result = nodeDialog.id
        ? await api.updateMihomoNode(nodeDialog.id, body)
        : await api.addMihomoNode(body as Omit<MihomoManualNode, 'id'> | { yaml: string });
      // A paste may carry several mappings at once.
      const savedNodes = result.nodes ?? (result.node ? [result.node] : []);
      if (savedNodes.length > 0) {
        const current = mihomo.manualNodes ?? [];
        const byId = new Map(savedNodes.map(node => [node.id, node]));
        const next = current.map(node => byId.get(node.id) ?? node);
        for (const node of savedNodes) {
          if (!next.some(item => item.id === node.id)) next.push(node);
        }
        commitManualNodes(next);
      }
      setNodeDialog(null);
      setNodeFieldError(null);
      await refreshNodes();
      toast.success(t('proxy.savedNotice'));
    } catch (err: any) {
      // The backend names the offending field; keep the dialog open and put the
      // message on that control instead of a toast the operator must memorise.
      if (err instanceof OcApiError && err.reasonCode === 'invalid-node-field') {
        const field = (err.body as { field?: string } | undefined)?.field;
        setNodeFieldError({ field, message: t('proxy.nodeFieldInvalid', { field: field ?? '' }) });
      } else {
        toastFailure(err);
      }
    } finally {
      setNodeBusy(false);
    }
  };

  const removeNode = async (node: MihomoManualNode) => {
    const ok = await confirm({ title: t('proxy.nodeDelete'), description: node.name, danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;
    try {
      await api.deleteMihomoNode(node.id);
      const selectedNodes = Object.fromEntries(
        Object.entries(mihomo.selectedNodes ?? {}).filter(([, name]) => name !== node.name),
      );
      commitManualNodes((mihomo.manualNodes ?? []).filter(item => item.id !== node.id), selectedNodes);
      await refreshNodes();
    } catch (err: any) {
      toastFailure(err);
    }
  };

  const ensureNodeCatalog = async (): Promise<MihomoNodeCatalog | null> => {
    if (nodeCatalog) return nodeCatalog;
    try {
      const { status: _status, ...catalog } = await api.getMihomoNodeCatalog();
      setNodeCatalog(catalog);
      return catalog;
    } catch (err: any) {
      toastFailure(err);
      return null;
    }
  };

  const openNodeDialog = (draft: NodeDraft) => {
    setNodeTest({ state: 'idle' });
    setNodeFieldError(null);
    setNodeDialog(draft);
  };

  const addNode = async () => {
    if (!(await ensureNodeCatalog())) return;
    openNodeDialog(emptyNodeDraft());
  };

  const editNode = async (manualId: string) => {
    try {
      const catalog = await ensureNodeCatalog();
      if (!catalog) return;
      const { nodes } = await api.getMihomoNodes();
      const node = nodes.find(item => item.id === manualId);
      if (node) openNodeDialog(nodeToDraft(node));
    } catch (err: any) {
      toastFailure(err);
    }
  };

  const patchNodeDraft = (partial: Partial<NodeDraft>) => {
    setNodeTest({ state: 'idle' });
    setNodeFieldError(null);
    setNodeDialog(prev => (prev ? { ...prev, ...partial } : prev));
  };

  /** Reachability is all the backend can prove for an unsaved node: the core
   *  has no route for it yet, so a full delay test would need a save + restart. */
  const probeNodeDraft = async () => {
    if (!nodeDialog) return;
    const body = nodeDialog.mode === 'yaml'
      ? { yaml: nodeDialog.yaml }
      : { server: nodeDialog.server.trim(), port: Number(nodeDialog.port) };
    setNodeTest({ state: 'running' });
    try {
      const result = await api.testMihomoNode(body);
      setNodeTest(result.reachable
        ? { state: 'ok', ms: result.ms }
        : { state: 'fail', error: result.error || 'error' });
    } catch (err: any) {
      setNodeTest({ state: 'fail', error: err?.message || 'error' });
    }
  };

  /** Probe one endpoint through the CURRENT node. Results stay keyed by URL so
   *  a batch over several candidates does not overwrite the previous answer;
   *  failures stay on the row (no toast per URL) — a batch would otherwise
   *  stack one popup per dead endpoint. */
  const probeUrl = async (url: string) => {
    setUrlProbes(prev => ({ ...prev, [url]: { state: 'testing' } }));
    try {
      const result = await api.testMihomoUrl(url, group || undefined);
      setUrlProbes(prev => ({
        ...prev,
        [url]: result.reachable
          ? { state: 'ok', ms: result.ms, node: result.node }
          : {
            state: 'fail',
            node: result.node,
            error: result.error === 'timeout' ? t('proxy.testUrlTimeout') : (result.error || 'error'),
          },
      }));
    } catch (err) {
      setUrlProbes(prev => ({
        ...prev,
        [url]: { state: 'fail', error: err instanceof Error ? err.message : 'error' },
      }));
      toastFailure(err);
    }
  };

  /** "Is this test URL usable here?" is a question about several candidate
   *  endpoints, not one: the presets are real service hosts, and one may be
   *  blocked by the node while another answers. Probes run through the same
   *  current node and never write the config — choosing a winner stays an
   *  explicit field edit (the card sets it), so a probe cannot silently change
   *  what the core health-checks. */
  const probeEveryUrl = async () => {
    if (!requireCore()) return;
    const targets = Array.from(new Set([...TEST_URL_PRESETS.map(preset => preset.url), activeTestUrl]));
    setUrlBatch({ running: true, done: 0, total: targets.length });
    let done = 0;
    await Promise.all(targets.map(async url => {
      await probeUrl(url);
      done += 1;
      setUrlBatch({ running: true, done, total: targets.length });
    }));
    setUrlBatch({ running: false, done: targets.length, total: targets.length });
  };

  /** A failed probe leaves one question open: is the endpoint dead for every
   *  exit, or just for the node in use? The nodes section answers that — its
   *  batch test runs the same URL across every group member. */
  const inspectEveryNode = async () => {
    setTab('nodes');
    if (nodes.length === 0) await refreshNodes().catch(toastFailure);
    void testAll();
  };

  const refreshOne = async (id: string) => {
    if (!requireCore()) return;
    setBusy(`refresh:${id}`);
    try {
      await api.refreshMihomoSubscription(id);
      await refreshSubs();
      toast.success(t('proxy.subRefresh'));
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    if (!requireCore()) return;
    setBusy('refresh-all');
    try {
      const result = await api.refreshAllMihomoSubscriptions();
      await refreshSubs();
      if (result.failed?.length) {
        toast.error(t('proxy.subRefreshPartial', { ok: result.refreshed?.length ?? 0, failed: result.failed.length }));
      } else {
        toast.success(t('proxy.subRefreshAll'));
      }
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const selectNode = async (name: string) => {
    if (!requireCore()) return;
    const wasDirty = dirty;
    setBusy(`select:${name}`);
    try {
      await api.selectMihomoProxy(group, name);
      setNodes(prev => prev.map(node => ({ ...node, selected: node.name === name })));
      const selectedNodes = { ...(mihomo.selectedNodes || {}), [group]: name };
      const nextProxy: ProxyShape = { ...(proxy || {}), mihomo: { ...mihomo, selectedGroup: group, selectedNodes } };
      setProxy(nextProxy);
      // The select route already wrote the file. Rebaseline only when the page
      // was clean; unrelated unsaved edits must keep the badge on.
      if (!wasDirty) {
        setSavedKey(mihomoKey(nextProxy));
      }
    } catch (err: any) {
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  /** The URL actually used by the next test: the field wins over the persisted
   *  value, so an unsaved edit is exercised without a save + core restart. */
  const activeTestUrl = (mihomo.testUrl ?? '').trim() || DEFAULT_MIHOMO_TEST_URL;

  const nodeSubmittable = nodeDialog
    ? nodeDialog.mode === 'yaml'
      ? Boolean(nodeDialog.yaml.trim())
      : rawNodeForm
        ? nodeIdentityValid(nodeDialog)
        : nodeDraftValid(nodeDialog)
    : false;

  const markReading = (name: string, reading: DelayReading) => {
    setDelayReadings(prev => ({ ...prev, [name]: reading }));
  };

  /** What the table shows for a row: a reading this console took, else the
   *  measurement the core reported, else untested. */
  const readingOf = useCallback((node: MihomoProxyNode): DelayReading => {
    const measured = delayReadings[node.name];
    if (measured) return measured;
    return typeof node.delay === 'number' && node.delay > 0
      ? { state: 'measured', ms: node.delay, at: 0 }
      : UNTESTED_DELAY;
  }, [delayReadings]);

  const testNode = async (name: string) => {
    if (!requireCore()) return;
    setBusy(`test:${name}`);
    // In flight is a state of its own: the row must not keep showing the
    // previous number while a new measurement is pending.
    markReading(name, { state: 'testing', at: Date.now() });
    try {
      const result = await api.testMihomoDelay(name, false, activeTestUrl);
      const ms = typeof result.delay === 'number' && result.delay > 0 ? result.delay : undefined;
      markReading(name, ms === undefined
        ? { state: 'timeout', at: Date.now() }
        : { state: 'measured', ms, at: Date.now() });
    } catch (err) {
      // A thrown call is a controller/protocol failure, not a timeout; the two
      // stay distinguishable so a broken core does not look like a dead node.
      markReading(name, {
        state: err instanceof OcApiError && err.reasonCode === 'timeout' ? 'timeout' : 'error',
        at: Date.now(),
      });
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const testAll = async () => {
    if (!requireCore()) return;
    setBusy('test-all');
    const names = nodes.map(node => node.name);
    const startedAt = Date.now();
    // Every row enters "testing" up front: an in-flight batch leaves no cell
    // claiming an older measurement. All testings share one rank, so the sort
    // order cannot churn while results are arriving.
    setDelayReadings(prev => {
      const next = { ...prev };
      for (const name of names) next[name] = { state: 'testing', at: startedAt };
      return next;
    });
    try {
      const result = await api.testMihomoDelay(group, true, activeTestUrl);
      const delays = result.delays || {};
      const settledAt = Date.now();
      // The batch covers every member: a name missing from the response (or
      // reported as 0) failed its test, so its old number is stale.
      setDelayReadings(prev => {
        const next = { ...prev };
        for (const name of names) {
          const ms = delays[name];
          next[name] = typeof ms === 'number' && ms > 0
            ? { state: 'measured', ms, at: settledAt }
            : { state: 'timeout', at: settledAt };
        }
        return next;
      });
    } catch (err) {
      // The batch itself never ran: an error per row is the honest reading,
      // not N timeouts blaming the nodes.
      const failedAt = Date.now();
      setDelayReadings(prev => {
        const next = { ...prev };
        for (const name of names) next[name] = { state: 'error', at: failedAt };
        return next;
      });
      toastFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const providerById = useMemo(() => {
    const map = new Map<string, MihomoProviderInfo>();
    for (const provider of providers) map.set(provider.name, provider);
    return map;
  }, [providers]);

  /** The node the group is actually routing through right now. Rendered OUTSIDE
   *  the scrolling body and above the filters that may hide it: "which node am I
   *  on" must never require scrolling a 100-row list or clearing a filter. */
  const currentNode = useMemo(() => nodes.find(node => node.selected) ?? null, [nodes]);
  const currentReading = currentNode ? readingOf(currentNode) : UNTESTED_DELAY;
  const currentRowRef = useRef<HTMLTableRowElement | null>(null);
  /** Set by the header pill: after the tab switch renders, scroll that row into
   *  view. State (not a direct DOM call) because the row does not exist until the
   *  nodes tab has mounted. */
  const [scrollToCurrent, setScrollToCurrent] = useState(false);

  const jumpToCurrentNode = () => {
    setTab('nodes');
    setScrollToCurrent(true);
    if (nodes.length === 0) void refreshNodes().catch(toastFailure);
  };

  useEffect(() => {
    if (!scrollToCurrent || tab !== 'nodes') return;
    const row = currentRowRef.current;
    if (!row) return; // the list is still loading; the next nodes update re-runs this
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setScrollToCurrent(false);
  }, [scrollToCurrent, tab, nodes]);

  /** The source filter narrows the TYPE options too: choosing an airport must
   *  not keep offering a protocol only another airport provides. A type whose
   *  last member disappeared with the source change simply stops filtering. */
  const typeOptions = useMemo(() => {
    const byType = new Map<string, number>();
    for (const node of nodes) {
      if (sourceFilter && nodeSourceKey(node.source) !== sourceFilter) continue;
      if (!node.type || node.type === 'Unknown') continue;
      byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    }
    return [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [nodes, sourceFilter]);

  const activeType = typeOptions.some(option => option.type === typeFilter) ? typeFilter : '';

  const visibleNodes = useMemo(() => {
    let scoped = sourceFilter ? nodes.filter(node => nodeSourceKey(node.source) === sourceFilter) : nodes;
    if (activeType) scoped = scoped.filter(node => node.type === activeType);
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(node => node.name.toLowerCase().includes(q) || node.type.toLowerCase().includes(q));
  }, [nodes, query, sourceFilter, activeType]);

  /** Subscription id → the name the operator gave it. The config list carries
   *  it; the live subs fetch refreshes it after a rename without a full reload. */
  const subscriptionNameById = useMemo(() => {
    const byId = new Map<string, string>();
    for (const sub of mihomo.subscriptions ?? []) byId.set(sub.id, sub.name || sub.id);
    for (const sub of subs) byId.set(sub.id, sub.name || sub.id);
    return byId;
  }, [mihomo.subscriptions, subs]);

  /** One label per origin that actually contributed a node. Built-ins are
   *  deliberately absent: filtering to DIRECT is a list of one and the source
   *  column already says what it is. */
  const sourceOptions = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; count: number }>();
    for (const node of nodes) {
      if (node.source.kind === 'builtin') continue;
      const key = nodeSourceKey(node.source);
      const label = node.source.kind === 'manual'
        ? t('proxy.nodeSourceManual')
        : subscriptionNameById.get(node.source.id ?? '') ?? node.source.id ?? '';
      const entry = byKey.get(key);
      if (entry) entry.count += 1;
      else byKey.set(key, { key, label, count: 1 });
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [nodes, subscriptionNameById, t]);

  /** Resolved display label for the table's source column. */
  const sourceLabel = (source: MihomoNodeSource): string => {
    if (source.kind === 'manual') return t('proxy.nodeSourceManual');
    if (source.kind === 'builtin') return t('proxy.nodeSourceBuiltin');
    return subscriptionNameById.get(source.id ?? '') ?? source.id ?? '';
  };

  // Delay sort is opt-in (config order is meaningful and is the default). A
  // state is not a number: measurements come first (asc or desc), then
  // timeouts, errors, in-flight tests and untested rows — so descending never
  // floats the "—" rows to the top. Ties break on name to stay stable across
  // re-renders.
  const sortedNodes = useMemo(() => {
    if (delaySort === 'none') return visibleNodes;
    const dir = delaySort === 'asc' ? 1 : -1;
    return [...visibleNodes].sort((a, b) => {
      const ra = readingOf(a);
      const rb = readingOf(b);
      const rank = delayRank(ra.state) - delayRank(rb.state);
      if (rank !== 0) return rank;
      if (ra.state === 'measured' && ra.ms !== rb.ms) return ((ra.ms ?? 0) - (rb.ms ?? 0)) * dir;
      return a.name.localeCompare(b.name);
    });
  }, [visibleNodes, delaySort, readingOf]);

  /**
   * Save action row: the fixed footer of a scrolling pane section, so the
   * fields scroll and the action never does.
   * The hint names the scope: a save writes the `mihomo` block (core settings,
   * subscriptions, node selection, rules) and merges over whatever the sibling
   * proxy pages have on disk — the button must not read as "save this field".
   * The badge is the only honest way to answer "did my edit land yet".
   */
  const saveBar = (hintKey: string) => (
    <div className="pane-section-footer">
      {/* Action on the LEADING edge, aligned with the fields above it; the hint
          trails it, so the button never floats at a pane's far corner. */}
      <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving || !dirty}>
        <Save size={14} />
        <span>{t('proxy.saveBtn')}</span>
      </button>
      {dirty && <span className="badge badge-warning">{t('proxy.unsaved')}</span>}
      {/* The scope is a paragraph of truth, not a slogan — but a paragraph in a
          footer reads as documentation nobody reads. It lives in the InfoTip
          beside the button, one hover away and never in the way. */}
      <InfoTip text={t(hintKey)} />
    </div>
  );

  if (loading || !proxy) {
    return <div style={{ color: 'var(--text-dim)' }}>{t('common.loading')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0 }}>
      {/* The scope switch is gone with the split: this page IS the Mihomo
          scope. What remains is the live-node pill, kept on the trailing edge
          where it sat before. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* The node actually in use, on every scope: a micro-label pill instead
              of a settings row, and clicking it anchors to that row in the list —
              "which node am I on" is answerable without opening a tab. */}
          {coreReady && (
            <button type="button" className="current-node" onClick={() => jumpToCurrentNode()}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: currentNode ? 'var(--accent-emerald)' : 'var(--accent-amber)' }} />
              <span style={{ color: 'var(--text-dim)' }}>{t('proxy.nodeCurrent')}</span>
              <span className="node-name">{currentNode ? currentNode.name : t('proxy.nodeNone')}</span>
              {currentNode && (
                <span style={{ color: 'var(--text-dim)' }}>
                  {currentNode.name === 'DIRECT' ? t('proxy.direct') : currentNode.type}
                  {currentReading.state === 'measured' ? ` · ${t('proxy.nodeDelay', { ms: currentReading.ms ?? 0 })}` : ''}
                </span>
              )}
              {groupType !== 'select' && <span className="badge badge-amber">{t('proxy.nodeAutoBadge')}</span>}
            </button>
          )}
        </div>
      </div>
        <div className="page-split">
          <nav className="page-subnav" aria-label={t('proxy.tabMihomo')}>
            {SUB_TABS.map(item => (
              <button
                key={item.value}
                type="button"
                aria-pressed={tab === item.value}
                className={tab === item.value ? 'nav-item is-active' : 'nav-item'}
                onClick={() => setTab(item.value)}
              >
                {item.icon}
                <span className="nav-item-label">{t(item.labelKey)}</span>
              </button>
            ))}
          </nav>
          <div className="page-split-body">
              {mode !== 'mihomo' && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.mihomoModeOff')}</div>
              )}
              {tab === 'general' && (
              // The fields are the tall part, so they own the scroll; the save
              // row is the section's footer and must stay reachable without
              // scrolling a form to its end (same shape as Settings: header and
              // action pinned, only the cards scroll).
              <div className="pane-section">
                <div className="pane-section-scroll">

                {/* Core lifecycle: the two state pills live in the header (colour
                    = recognizability), the binary's own caveats sit under them as
                    plain lines, and the four controls follow. Their availability
                    tracks the core's state: a running core offers stop/restart and
                    refuses start — and the binary cannot be swapped under a live
                    process. */}
                <div id="mihomo-core-card" className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={sectionTitle}>
                      <Cpu size={14} />
                      <span>{t('proxy.statusTitle')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                      {/* State reads as two pills first (colour = recognizability), with the
                          version / pid as plain metadata after them. */}
                      <span
                        className={status?.running ? 'badge badge-success' : 'badge'}
                        style={status?.running ? undefined : { background: 'var(--chip-bg)', color: 'var(--text-dim)' }}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: status?.running ? 'var(--accent-emerald)' : 'var(--accent-rose)', flexShrink: 0 }} />
                        {status?.running ? t('proxy.running') : t('proxy.stopped')}
                      </span>
                      <span
                        className={status?.installed ? 'badge' : 'badge badge-warning'}
                        style={status?.installed ? { background: 'var(--chip-bg)', color: 'var(--text-dim)' } : undefined}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: status?.installed ? 'var(--accent-emerald)' : 'var(--accent-amber)', flexShrink: 0 }} />
                        {status?.installed ? t('proxy.installed') : t('proxy.notInstalled')}
                      </span>
                      {status?.version ? <span>{status.version}</span> : null}
                      {status?.pid ? <span>{t('proxy.pid')} {status.pid}</span> : null}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                    <div>{t('proxy.coreHint')}</div>
                    <div>{status?.secretConfigured ? t('proxy.secretSet') : t('proxy.secretMissing')}</div>
                    {status?.error && (
                      <div style={{ color: 'var(--accent-amber)' }}>
                        {(status.code && CORE_ERROR_KEYS[status.code] ? t(CORE_ERROR_KEYS[status.code]) : status.error)}
                      </div>
                    )}
                  </div>
                  {/* Run policy, deliberately separate from the outbound mode
                      below: the core is a capability of its own. Turning this off
                      does not point traffic elsewhere — it only stops keeping the
                      process alive. Absent in the file = follow the mode. */}
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', fontSize: 'var(--text-sm)' }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span>{t('proxy.mihomoAutoStart')}</span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                        {t('proxy.mihomoAutoStartHint')}
                      </span>
                    </span>
                    <Switch
                      checked={mihomo.autoStart ?? mode === 'mihomo'}
                      disabled={busy !== null}
                      onChange={v => void setAutoStart(v)}
                    />
                  </label>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button className="btn btn-sm btn-primary" disabled={busy !== null || coreReady} title={coreReady ? t('proxy.alreadyRunning') : undefined} onClick={() => void runCore('start')}><Play size={13} /><span>{t('proxy.start')}</span></button>
                    <button className="btn btn-sm" disabled={busy !== null || !coreReady} title={coreReady ? undefined : t('proxy.notRunning')} onClick={() => void runCore('stop')}><Square size={13} /><span>{t('proxy.stop')}</span></button>
                    <button className="btn btn-sm" disabled={busy !== null || !coreReady} title={coreReady ? undefined : t('proxy.notRunning')} onClick={() => void runCore('restart')}><RefreshCw size={13} /><span>{t('proxy.restart')}</span></button>
                    <button className="btn btn-sm" disabled={busy !== null || coreReady} title={coreReady ? t('proxy.stopFirst') : undefined} onClick={() => void runCore('install')}>
                      <span>{installLabel()}</span>
                    </button>
                  </div>
                </div>
                {/* Outbound mode + listening ports. `direct` is the quick kill switch
                    that keeps the core (and its subscription updates) alive while
                    traffic bypasses the tunnel; `rule` applies the generated MATCH
                    rule, which today equals `global`. The mode is applied live via the
                    controller, so switching never restarts the core — the ports are
                    baked into the generated config instead, which is why they are
                    editable only while the core is stopped. */}
                <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={sectionTitle}>
                    <ArrowLeftRight size={14} />
                    <span>{t('proxy.outboundSection')}</span>
                  </div>
                  <SegGroup
                    value={mihomo.routingMode ?? 'rule'}
                    onChange={v => void changeRoutingMode(v as MihomoRoutingMode)}
                    options={[
                      { value: 'rule', label: t('proxy.routingRule') },
                      { value: 'global', label: t('proxy.routingGlobal') },
                      { value: 'direct', label: t('proxy.routingDirect') },
                    ]}
                  />
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.routingHint')}</div>
                  {coreReady && !routingPending && status?.liveRoutingMode && status.liveRoutingMode !== (mihomo.routingMode ?? 'rule') && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>
                      {t('proxy.routingLiveMismatch', { live: t(`proxy.routing${status.liveRoutingMode === 'rule' ? 'Rule' : status.liveRoutingMode === 'global' ? 'Global' : 'Direct'}`) })}
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', borderTop: '1px solid var(--divider)', paddingTop: '12px' }}>
                    <div>
                      <label style={fieldLabel}>{t('proxy.mixedPort')}</label>
                      <input
                        className="input"
                        type="number"
                        disabled={coreReady}
                        value={mihomo.mixedPort ?? DEFAULT_MIHOMO_MIXED_PORT}
                        onChange={e => patchMihomo({ mixedPort: Number(e.target.value) })}
                      />
                    </div>
                    <div>
                      <label style={fieldLabel}>{t('proxy.controllerPort')}</label>
                      <input
                        className="input"
                        type="number"
                        disabled={coreReady}
                        value={mihomo.controllerPort ?? DEFAULT_MIHOMO_CONTROLLER_PORT}
                        onChange={e => patchMihomo({ controllerPort: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                  {coreReady && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.portsLocked')}</div>
                  )}
                </div>
                {/* Who picks the node. Applied by the generated config, so unlike
                    the outbound mode this one takes a save (and a core restart);
                    `url-test`/`fallback` also disable the console's own picker. */}
                <div className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={sectionTitle}>
                    <Network size={14} />
                    <span>{t('proxy.groupTypeLabel')}</span>
                  </div>
                  <SegGroup
                    value={mihomo.groupType ?? 'select'}
                    onChange={v => patchMihomo({ groupType: v as MihomoGroupType })}
                    options={[
                      { value: 'select', label: t('proxy.groupSelect') },
                      { value: 'url-test', label: t('proxy.groupUrlTest') },
                      { value: 'fallback', label: t('proxy.groupFallback') },
                    ]}
                  />
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.groupHint')}</div>
                  {(mihomo.groupType ?? 'select') !== 'select' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                      <div>
                        <label style={fieldLabel}>{t('proxy.groupInterval')}</label>
                        <input
                          className="input"
                          type="number"
                          min={MIHOMO_GROUP_INTERVAL_MIN_SEC}
                          max={MIHOMO_GROUP_INTERVAL_MAX_SEC}
                          value={mihomo.groupInterval ?? DEFAULT_MIHOMO_GROUP_INTERVAL_SEC}
                          onChange={e => patchMihomo({ groupInterval: Number(e.target.value) })}
                        />
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
                          {t('proxy.groupIntervalHint', { sec: mihomo.groupInterval ?? DEFAULT_MIHOMO_GROUP_INTERVAL_SEC })}
                        </div>
                      </div>
                      {(mihomo.groupType ?? 'select') === 'url-test' && (
                        <div>
                          <label style={fieldLabel}>{t('proxy.groupTolerance')}</label>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            max={MIHOMO_GROUP_TOLERANCE_MAX_MS}
                            value={mihomo.groupTolerance ?? DEFAULT_MIHOMO_GROUP_TOLERANCE_MS}
                            onChange={e => patchMihomo({ groupTolerance: Number(e.target.value) })}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {/* The health check does not only drive latency readouts: an
                      automatic group's own url-test uses this same URL, and the
                      generated provider health-check carries it too. That makes
                      it a basic setting, not a nodes-table filter. */}
                  <div>
                    <label style={fieldLabel}>{t('proxy.nodeTestUrl')}</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        className="input"
                        style={{ flex: 1 }}
                        value={mihomo.testUrl ?? ''}
                        placeholder={DEFAULT_MIHOMO_TEST_URL}
                        spellCheck={false}
                        onChange={e => patchMihomo({ testUrl: e.target.value })}
                      />
                      {/* The probe surface lives on its own section: it is about
                          endpoints, the same current node and several cards, not
                          a settings field. Setting a winner here stays a field
                          edit, so the save that writes it is the settings card's. */}
                      <button
                        className="btn"
                        onClick={() => setTab('test')}
                        style={{ flexShrink: 0, justifyContent: 'center', whiteSpace: 'nowrap' }}
                      >
                        <Activity size={12} />
                        <span>{t('proxy.tabTest')}</span>
                      </button>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '6px' }}>
                      {t('proxy.nodeTestUrlHint')}
                    </div>
                  </div>
                </div>
                {/* PAC: clients that only accept an auto-config URL (browsers, OS
                    proxy settings) get the mixed port AND the direct-bypass list
                    from one URL the gateway serves itself. The URL is reference
                    material, not a form field — it lives behind a button so the
                    section stays one line of chrome instead of a fake read-only input. */}
                <div className="sub-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={sectionTitle}>
                      <Link2 size={14} />
                      <span>{t('proxy.clientAccess')}</span>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>{t('proxy.pacSummary')}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => setPacOpen(true)}>
                    <span>{t('proxy.pacOpen')}</span>
                  </button>
                </div>
                {pacOpen && (
                  <Dialog
                    title={t('proxy.pacLabel')}
                    subtitle={<span>{t('proxy.pacHint')}</span>}
                    onClose={() => setPacOpen(false)}
                    closeLabel={t('common.close')}
                    width={560}
                    footerRight={
                      <button className="btn btn-primary" onClick={() => void copyPac()}>
                        <Copy size={13} />
                        <span>{t('common.copy')}</span>
                      </button>
                    }
                  >
                    <input className="input" readOnly value={pacUrl} style={{ fontFamily: 'var(--font-mono)' }} onFocus={e => e.currentTarget.select()} />
                  </Dialog>
                )}
                </div>
                {saveBar('proxy.saveHintCore')}
              </div>
            )}

            {tab === 'test' && (
              <div className="pane-section">
                <div className="pane-section-scroll" style={{ overflow: 'hidden' }}>
                  {/* The section fills the pane; only the endpoint grid scrolls,
                      so the header (run buttons, current node/URL) and the custom
                      endpoint row stay put while the list moves. */}
                  <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, minHeight: 0 }}>
                    {/* Title, run actions and the current node/URL line are ONE
                        header block: the card's 14px gap belongs between this
                        block and the list, not inside it. */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      <div className="card-header" style={{ marginBottom: 0 }}>
                        <div className="card-title"><span>{t('proxy.tabTest')}</span></div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <button className="btn btn-sm" disabled={!coreReady || urlBatch.running} onClick={() => void probeEveryUrl()}>
                            {urlBatch.running ? <Loader2 size={12} style={SPIN} /> : <Play size={12} />}
                            <span>
                              {urlBatch.running
                                ? t('proxy.testUrlBatchRunning', { done: urlBatch.done, n: urlBatch.total })
                                : t('proxy.testUrlBatch')}
                            </span>
                          </button>
                          {/* The other axis: one URL, every member. It lives on the
                              nodes section because the numbers belong to the rows. */}
                          <button className="btn btn-sm" disabled={!coreReady || urlBatch.running} onClick={() => void inspectEveryNode()}>
                            <Network size={12} />
                            <span>{t('proxy.testUrlAllNodes')}</span>
                          </button>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                        <span>
                          {t('proxy.testCurrentNode')}{' '}
                          <strong style={{ color: 'var(--text)' }}>{currentNode?.name ?? '—'}</strong>
                        </span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {t('proxy.testCurrentUrl')}{' '}
                          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text)', wordBreak: 'break-all' }}>
                            {activeTestUrl}
                          </code>
                        </span>
                        <button className="btn btn-sm" onClick={() => setTab('general')}>
                          <span>{t('proxy.testChangeUrl')}</span>
                        </button>
                      </div>
                      {!coreReady && (
                        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.notRunning')}</div>
                      )}
                    </div>
                    {/* One card per site: brand mark, host, its own last outcome,
                        and the two explicit actions. A probe never writes the
                        config — "use as test URL" is the only writer. */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start', paddingRight: 4 }}>
                      {TEST_URL_PRESETS.map(preset => {
                        const probe = urlProbes[preset.url];
                        const inUse = preset.url === activeTestUrl;
                        return (
                          <div key={preset.url} className="sub-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                              <EndpointLogo mark={preset.logo} />
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontWeight: 'var(--font-semibold)', fontSize: 'var(--text-md)' }}>{preset.label}</div>
                                <div
                                  title={preset.url}
                                  style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >{endpointHost(preset.url)}</div>
                              </div>
                              {inUse && <span className="badge badge-success">{t('proxy.testInUse')}</span>}
                            </div>
                            <div style={{ minHeight: 18, fontSize: 'var(--text-xs)', display: 'flex', alignItems: 'center', gap: 6 }} title={probe?.error}>
                              {probe?.state === 'testing' && <><Loader2 size={12} style={SPIN} /><span style={{ color: 'var(--text-dim)' }}>{t('proxy.nodeTesting')}</span></>}
                              {probe?.state === 'ok' && (
                                <>
                                  <CheckCircle2 size={13} style={{ color: 'var(--accent-emerald)' }} />
                                  <span style={{ color: delayColor({ state: 'measured', ms: probe.ms, at: 0 }), fontVariantNumeric: 'tabular-nums' }}>
                                    {t('proxy.nodeTestOk', { ms: probe.ms ?? 0 })}
                                  </span>
                                </>
                              )}
                              {probe?.state === 'fail' && (
                                <>
                                  <XCircle size={13} style={{ color: 'var(--accent-rose)' }} />
                                  <span style={{ color: 'var(--accent-rose)' }}>{t('proxy.nodeTestFail', { error: probe.error ?? 'error' })}</span>
                                </>
                              )}
                              {!probe && <span style={{ color: 'var(--text-dim)' }}>—</span>}
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                className="btn btn-sm"
                                disabled={!coreReady || probe?.state === 'testing'}
                                onClick={() => void probeUrl(preset.url)}
                              >
                                {probe?.state === 'testing' ? <Loader2 size={12} style={SPIN} /> : <Play size={12} />}
                                <span>{t('proxy.testUrlBtn')}</span>
                              </button>
                              {/* Choosing is a FIELD edit, so it hands the
                                  operator to the settings card that owns the
                                  save — this tab only measures. */}
                              <button
                                className="btn btn-sm"
                                disabled={inUse}
                                onClick={() => { patchMihomo({ testUrl: preset.url }); setTab('general'); }}
                              >
                                <span>{t('proxy.testUse')}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--divider)', paddingTop: '12px' }}>
                      <label style={{ ...fieldLabel, marginBottom: 0 }}>{t('proxy.testCustomLabel')}</label>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 240 }}
                        value={customTestUrl}
                        placeholder={DEFAULT_MIHOMO_TEST_URL}
                        spellCheck={false}
                        onChange={e => setCustomTestUrl(e.target.value)}
                      />
                      <button
                        className="btn btn-sm"
                        disabled={!coreReady || !customTestUrl.trim() || urlProbes[customTestUrl.trim()]?.state === 'testing'}
                        onClick={() => void probeUrl(customTestUrl.trim())}
                      >
                        <Play size={12} />
                        <span>{t('proxy.testUrlBtn')}</span>
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={!customTestUrl.trim()}
                        onClick={() => { patchMihomo({ testUrl: customTestUrl.trim() }); setTab('general'); }}
                      >
                        <span>{t('proxy.testUse')}</span>
                      </button>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.testCustomHint')}</div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'subscriptions' && (
          <>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: 1, minHeight: 0 }}>
            <div className="card-header">
              <div className="card-title"><span>{t('proxy.tabSubscriptions')}</span></div>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void refreshAll()}>
                <RefreshCw size={13} />
                <span>{t('proxy.subRefreshAll')}</span>
              </button>
            </div>
            {/* Create-only panel. Editing is per row (see below): one form
                could not tell "add" and "edit" apart, and the enable switch
                was buried inside it instead of sitting on the row it governs. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr 120px auto', gap: '8px', alignItems: 'end' }}>
              <div>
                <label style={fieldLabel}>{t('proxy.subName')}</label>
                <input className="input" value={newSub.name} onChange={e => setNewSub({ ...newSub, name: e.target.value })} />
              </div>
              <div>
                <label style={fieldLabel}>{t('proxy.subUrl')}</label>
                <input className="input" value={newSub.url} onChange={e => setNewSub({ ...newSub, url: e.target.value })} placeholder="https://" />
              </div>
              <div>
                <label style={fieldLabel}>{t('proxy.subInterval')}</label>
                <input className="input" type="number" value={newSub.interval} onChange={e => setNewSub({ ...newSub, interval: e.target.value })} />
              </div>
              <button className="btn btn-primary" disabled={busy === 'sub' || !newSub.name.trim() || !newSub.url.trim()} onClick={() => void addSub()}>
                <Plus size={13} />
                <span>{t('proxy.subAdd')}</span>
              </button>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.subIntervalHint')}</div>
            {subs.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.subEmpty')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0, overflowY: 'auto' }}>
                {subs.map(sub => {
                  const info = providerById.get(sub.id);
                  // '' when the provider never fetched (the client drops Go's
                  // 0001-01-01 zero time) — the label is omitted, never rendered
                  // as an epoch artifact.
                  const updated = formatTimestamp(info?.updatedAt);
                  const enabled = sub.enabled !== false;
                  return (
                    <div key={sub.id} style={{ border: '1px solid var(--divider)', borderRadius: '8px', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', opacity: enabled ? 1 : 0.6 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.name}</span>
                          {enabled ? null : <span className="badge">{t('proxy.subDisabled')}</span>}
                        </div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.url}</div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '4px' }}>
                          {typeof info?.nodeCount === 'number' ? t('proxy.subNodes', { count: info.nodeCount }) : t('proxy.subNever')}
                          {enabled ? ` · ${t('proxy.subAutoEvery', { every: fmtDur((sub.interval ?? DEFAULT_MIHOMO_SUB_INTERVAL_SEC) * 1000) })}` : null}
                          {updated ? (
                            <>
                              {' · '}
                              <span title={info?.updatedAt}>{t('proxy.subUpdated', { time: updated })}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center' }}>
                        {/* Enable/disable is a one-click state flip on the row
                            itself, not something you open the edit form for. */}
                        <Switch checked={enabled} size="sm" ariaLabel={t('proxy.subEnabled')} disabled={busy === `toggle:${sub.id}`} onChange={v => void toggleSub(sub, v)} />
                        <button
                          className="btn btn-sm"
                          onClick={() => setEditSub({ id: sub.id, name: sub.name, url: sub.url, interval: String(sub.interval ?? DEFAULT_MIHOMO_SUB_INTERVAL_SEC), enabled })}
                        >
                          {t('proxy.subEdit')}
                        </button>
                        <button className="btn btn-sm" disabled={busy !== null} onClick={() => void refreshOne(sub.id)}>{t('proxy.subRefresh')}</button>
                        <button className="btn btn-sm" onClick={() => void removeSub(sub)}>{t('proxy.subDelete')}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {editSub && (
            <Dialog
              title={t('proxy.subEdit')}
              width={560}
              closeLabel={t('common.close')}
              onClose={() => { if (busy !== 'sub') setEditSub(null); }}
              closeDisabled={busy === 'sub'}
              footerLeft={
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                  <Switch checked={editSub.enabled} onChange={v => setEditSub({ ...editSub, enabled: v })} />
                  <span>{t('proxy.subEnabled')}</span>
                </label>
              }
              footerRight={
                <>
                  <button className="btn" disabled={busy === 'sub'} onClick={() => setEditSub(null)}>{t('common.cancel')}</button>
                  <button className="btn btn-primary" disabled={busy === 'sub' || !editSub.name.trim() || !editSub.url.trim()} onClick={() => void saveSubEdit()}>
                    {t('common.save')}
                  </button>
                </>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label style={fieldLabel}>{t('proxy.subName')}</label>
                  <input className="input" value={editSub.name} onChange={e => setEditSub({ ...editSub, name: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabel}>{t('proxy.subUrl')}</label>
                  <input className="input" value={editSub.url} onChange={e => setEditSub({ ...editSub, url: e.target.value })} />
                </div>
                <div>
                  <label style={fieldLabel}>{t('proxy.subInterval')}</label>
                  <input className="input" type="number" value={editSub.interval} onChange={e => setEditSub({ ...editSub, interval: e.target.value })} />
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{t('proxy.subIntervalHint')}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>{t('proxy.subEnabledHint')}</div>
              </div>
            </Dialog>
          )}
          </>
        )}

            {tab === 'rules' && (
          <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', flex: '0 0 auto' }}>
            <SegGroup
              value={rulesView}
              onChange={v => setRulesView(v as 'edit' | 'live')}
              options={[
                { value: 'live', label: t('proxy.rulesViewLive') },
                { value: 'edit', label: t('proxy.rulesViewEdit') },
              ]}
            />
          </div>
          {/* The editable list. Saving writes the whole ordered list into the
              generated config and reconciles the core; the table below stays
              read-only because it reports what the core actually loaded. */}
          <div className="card" style={{ display: rulesView === 'edit' ? 'flex' : 'none', flexDirection: 'column', gap: '10px', flex: 1, minHeight: 0 }}>
            <div className="card-header" style={RULES_CARD_HEADER}>
              <div className="card-title">
                <span>{t('proxy.rulesCustomTitle')}</span>
                {customRules.length > 0 && <span className="badge">{customRules.length}</span>}
                {customRulesDirty && <span className="badge badge-warning">{t('proxy.unsaved')}</span>}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setImportResult(null);
                    setImportOpen(true);
                  }}
                >
                  <Download size={13} />
                  <span>{t('proxy.rulesImport')}</span>
                </button>
                <button className="btn btn-sm" disabled={busy !== null} onClick={addRule}>
                  <Plus size={13} />
                  <span>{t('proxy.rulesAdd')}</span>
                </button>
              </div>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
              {t('proxy.rulesCustomHint')}
            </div>
            {customRules.length === 0 ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('proxy.rulesCustomEmpty')}</div>
            ) : (
              // This wrapper must be the shrinking box, not its parent: without
              // flex:1 it grows to the full row count, the bounded list inside
              // never scrolls, and the save bar is pushed off the card.
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <Combobox
                    value={ruleSourceFilter}
                    onChange={setRuleSourceFilter}
                    clearable
                    placeholder={t('proxy.rulesSourceAll')}
                    options={ruleSourceOptions}
                  />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {t('proxy.rulesShown', { n: ruleRows.length })}
                  </span>
                </div>
                {/* Same floor discipline as the node table: six fixed tracks plus the
                    payload input, which resolves min-width 0 — without a floor it is
                    the column that disappears and the action buttons clip at the edge. */}
                <ScrollTable
                  fill
                  minWidth={760}
                  columns={[
                    { key: 'idx', label: '#', width: 36 },
                    {
                      key: 'sel',
                      label: (
                        <input
                          type="checkbox"
                          checked={allRulesSelected}
                          onChange={toggleAllRules}
                          aria-label={t('proxy.rulesSelectAll')}
                          title={t('proxy.rulesSelectAll')}
                          style={{ accentColor: 'var(--accent)', margin: 0 }}
                        />
                      ),
                      width: 34,
                    },
                    { key: 'type', label: t('proxy.rulesType'), width: 168 },
                    { key: 'payload', label: t('proxy.rulesPayload') },
                    { key: 'target', label: t('proxy.rulesTarget'), width: 120 },
                    { key: 'source', label: t('proxy.rulesSource'), width: 120 },
                    { key: 'act', label: '', width: 128, align: 'right' },
                  ]}
                  style={{ flex: '1 1 auto', minHeight: 0 }}
                >
                  {ruleRows.map(({ rule, index }) => (
                    <tr key={index}>
                      <td style={{ ...RULE_CELL, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{index + 1}</td>
                      <td style={RULE_CELL}>
                        <input
                          type="checkbox"
                          checked={ruleSel.has(index)}
                          onChange={() => toggleRuleSel(index)}
                          aria-label={t('proxy.rulesSelectRow', { n: index + 1 })}
                          style={{ accentColor: 'var(--accent)', margin: 0 }}
                        />
                      </td>
                      <td style={RULE_CELL}>
                        <Combobox
                          value={rule.type}
                          onChange={v => editRule(index, { type: v as MihomoRuleType })}
                          options={RULE_TYPE_OPTIONS}
                        />
                      </td>
                      <td style={RULE_CELL}>
                        <input
                          className="input"
                          style={{ minWidth: 0, ...(rule.payload.trim() ? null : { borderColor: 'var(--accent-amber)' }) }}
                          value={rule.payload}
                          placeholder={RULE_PAYLOADS[rule.type] ?? ''}
                          onChange={e => editRule(index, { payload: e.target.value })}
                        />
                      </td>
                      <td style={RULE_CELL}>
                        <Combobox
                          value={rule.target}
                          onChange={v => editRule(index, { target: v as MihomoRuleTarget })}
                          options={RULE_TARGET_OPTIONS}
                        />
                      </td>
                      <td
                        title={rule.source || t('proxy.rulesSourceManual')}
                        style={{ ...RULE_CELL, fontSize: 'var(--text-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      >
                        {rule.source || t('proxy.rulesSourceManual')}
                      </td>
                      <td style={RULE_CELL}>
                        <div style={{ display: 'flex', gap: '2px', justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-sm"
                            disabled={index === 0}
                            onClick={() => moveRule(index, -1)}
                            aria-label={t('proxy.rulesMoveUp')}
                            title={t('proxy.rulesMoveUp')}
                          >
                            <ArrowUp size={13} />
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={index === customRules.length - 1}
                            onClick={() => moveRule(index, 1)}
                            aria-label={t('proxy.rulesMoveDown')}
                            title={t('proxy.rulesMoveDown')}
                          >
                            <ArrowDown size={13} />
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => removeRule(index)}
                            aria-label={t('proxy.rulesDelete')}
                            title={t('proxy.rulesDelete')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </ScrollTable>
              </div>
            )}
            {ruleSel.size > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)' }}>{t('proxy.rulesSelected', { n: ruleSel.size })}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.rulesSetTarget')}</span>
                {(['PROXY', 'DIRECT', 'REJECT'] as MihomoRuleTarget[]).map(target => (
                  <button key={target} className="btn btn-sm" onClick={() => batchSetTarget(target)}>{target}</button>
                ))}
                <button className="btn btn-sm" onClick={() => batchMove(-1)} title={t('proxy.rulesMoveUp')} aria-label={t('proxy.rulesMoveUp')}>
                  <ArrowUp size={13} />
                </button>
                <button className="btn btn-sm" onClick={() => batchMove(1)} title={t('proxy.rulesMoveDown')} aria-label={t('proxy.rulesMoveDown')}>
                  <ArrowDown size={13} />
                </button>
                <button className="btn btn-sm" onClick={batchRemove} title={t('proxy.rulesDelete')} aria-label={t('proxy.rulesDelete')}>
                  <Trash2 size={13} />
                </button>
                <button className="btn btn-sm" onClick={() => setRuleSel(new Set())}>{t('proxy.rulesClearSel')}</button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '0 0 auto', paddingTop: '10px', borderTop: '1px solid var(--card-border)' }}>
              <button
                className="btn btn-primary"
                disabled={busy !== null || !customRulesDirty || !customRulesValid}
                onClick={() => void saveCustomRules()}
              >
                <Save size={14} />
                <span>{t('proxy.rulesApply')}</span>
              </button>
              {!customRulesValid && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-amber)' }}>{t('proxy.rulesPayloadRequired')}</span>
              )}
            </div>
          </div>
          {importOpen && (
            <Dialog
              title={t('proxy.rulesImportTitle')}
              subtitle={<span>{t('proxy.rulesImportSubtitle')}</span>}
              onClose={() => setImportOpen(false)}
              closeLabel={t('common.close')}
              width={640}
              footerLeft={
                importResult ? (
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                    {t('proxy.rulesImportResult', {
                      imported: importResult.rules.length,
                      skipped: importResult.skipped.reduce((sum, row) => sum + row.count, 0),
                    })}
                    {importResult.source === 'cache'
                      ? ` ${t('proxy.rulesImportCacheNote')}`
                      : importResult.source === 'network'
                        ? ` ${t('proxy.rulesImportNetNote')}`
                        : ''}
                  </span>
                ) : null
              }
              footerRight={
                <>
                  <button className="btn" onClick={() => setImportOpen(false)}>{t('common.cancel')}</button>
                  {importResult ? (
                    <button
                      className="btn btn-primary"
                      disabled={importBusy || importPicked.size === 0}
                      onClick={commitImport}
                    >
                      {t('proxy.rulesImportCommit', { n: importPicked.size })}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      disabled={importBusy || (importSource === 'subscription' ? !importSubId : importText.trim() === '')}
                      onClick={() => void runImport()}
                    >
                      {importBusy ? t('common.loading') : t('proxy.rulesImportRun')}
                    </button>
                  )}
                </>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label style={fieldLabel}>{t('proxy.rulesImportSource')}</label>
                  <SegGroup
                    value={importSource}
                    onChange={v => {
                      setImportSource(v as 'subscription' | 'text');
                      setImportResult(null);
                      setImportPicked(new Set());
                    }}
                    options={[
                      { value: 'subscription', label: t('proxy.rulesImportSourceSub') },
                      { value: 'text', label: t('proxy.rulesImportSourceText') },
                    ]}
                  />
                </div>
                {importSource === 'subscription' ? (
                  <div>
                    <label style={fieldLabel}>{t('proxy.rulesImportPickSub')}</label>
                    <Combobox
                      value={importSubId}
                      onChange={v => { setImportSubId(v); setImportResult(null); setImportPicked(new Set()); }}
                      placeholder={t('proxy.rulesImportPickSub')}
                      options={subs.map((sub, index) => ({
                        value: sub.id || `#${index + 1}`,
                        label: sub.name || sub.id || `#${index + 1}`,
                      }))}
                    />
                  </div>
                ) : (
                  <div>
                    <label style={fieldLabel}>{t('proxy.rulesImportText')}</label>
                    <textarea
                      className="input"
                      style={{ width: '100%', minHeight: '160px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', resize: 'vertical' }}
                      value={importText}
                      onChange={e => { setImportText(e.target.value); setImportResult(null); setImportPicked(new Set()); }}
                      placeholder={t('proxy.rulesImportText')}
                    />
                  </div>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={importMap}
                    onChange={e => setImportMap(e.target.checked)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span>{t('proxy.rulesImportMapTarget')}</span>
                </label>
                {importResult && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)' }}>
                        {t('proxy.rulesImportPreview', { n: importPreview.length })}
                      </span>
                      {importPreview.length > 0 && (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              // Select-all covers what is visible: after a filter the
                              // operator is ticking a subset on purpose.
                              if (importVisible.every(({ index }) => importPicked.has(index))) {
                                setImportPicked(prev => {
                                  const next = new Set(prev);
                                  for (const { index } of importVisible) next.delete(index);
                                  return next;
                                });
                              } else {
                                setImportPicked(prev => {
                                  const next = new Set(prev);
                                  for (const { index } of importVisible) next.add(index);
                                  return next;
                                });
                              }
                            }}
                          >
                            {importVisible.length > 0 && importVisible.every(({ index }) => importPicked.has(index))
                              ? t('proxy.rulesClearSel')
                              : t('proxy.rulesSelectAll')}
                          </button>
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                            {t('proxy.rulesSelected', { n: importPicked.size })}
                          </span>
                        </>
                      )}
                    </div>
                    <input
                      className="input"
                      value={importFilter}
                      onChange={e => setImportFilter(e.target.value)}
                      placeholder={t('proxy.rulesFilterPlaceholder')}
                      style={{ maxWidth: '280px' }}
                    />
                    {importPreview.length === 0 ? (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.rulesImportNone')}</span>
                    ) : importVisible.length === 0 ? (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{t('proxy.rulesFilterEmpty')}</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '32vh', overflowY: 'auto', border: '1px solid var(--card-border)', borderRadius: 8, padding: '6px 8px' }}>
                        {importVisible.map(({ rule, index }) => (
                          <label
                            key={`${rule.type}|${rule.payload}|${rule.target}|${index}`}
                            style={{ display: 'grid', gridTemplateColumns: '22px 1fr 120px', gap: '8px', alignItems: 'center', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', cursor: 'pointer' }}
                          >
                            <input
                              type="checkbox"
                              checked={importPicked.has(index)}
                              onChange={() => toggleImportPick(index)}
                              style={{ accentColor: 'var(--accent)' }}
                            />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {rule.type} · {rule.payload}
                            </span>
                            <span style={{ color: 'var(--text-dim)' }}>{rule.target}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {importResult && importResult.skipped.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--font-semibold)', color: 'var(--accent-amber)' }}>
                      {t('proxy.rulesImportSkipped')}
                    </span>
                    {importResult.skipped.map(row => (
                      <span key={row.reason} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                        {row.reason} × {row.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Dialog>
          )}
          <div className="card" style={{ display: rulesView === 'live' ? 'flex' : 'none', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0 }}>
            <div className="card-header" style={RULES_CARD_HEADER}>
              <div className="card-title">
                <span>{t('proxy.tabRules')}</span>
                {rules.length > 0 && <span className="badge">{t('proxy.rulesCount', { n: rules.length })}</span>}
              </div>
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void refreshRules().catch(toastFailure)}>
                <RefreshCw size={13} />
                <span>{t('common.refresh')}</span>
              </button>
            </div>
            {!coreReady && <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.rulesNoCore')}</div>}
            {rulesError && <div style={{ color: 'var(--accent-amber)', fontSize: 'var(--text-xs)' }}>{rulesError}</div>}
            {/* The table is only half the answer while the generated config holds
                ONE rule: name the effective path — rule → group → node in use — so
                a single MATCH row cannot read as "nothing is configured". */}
            {coreReady && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: 'var(--text-xs)' }}>
                <span style={{ color: 'var(--text-dim)' }}>{t('proxy.rulesEffective')}</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>MATCH</span>
                <span style={{ color: 'var(--text-dim)' }}>→</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{group}</span>
                <span style={{ color: 'var(--text-dim)' }}>→</span>
                <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: currentNode ? 'var(--accent-emerald)' : 'var(--accent-amber)' }} />
                <strong>{currentNode ? currentNode.name : t('proxy.nodeNone')}</strong>
                {groupType !== 'select' && <span className="badge badge-amber">{t('proxy.nodeAutoBadge')}</span>}
              </div>
            )}
            <ScrollTable
              fill
              minWidth={560}
              columns={[
                { key: 'type', label: t('proxy.rulesType'), width: 170 },
                { key: 'payload', label: t('proxy.rulesPayload') },
                { key: 'proxy', label: t('proxy.rulesTarget'), width: 200 },
              ]}
              empty={t('proxy.rulesEmpty')}
            >
              {rules.map((rule, index) => (
                <tr key={`${rule.type}-${rule.payload}-${index}`}>
                  <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{rule.type}</td>
                  <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{rule.payload || '—'}</td>
                  <td style={{ padding: '8px 10px', color: rule.proxy === 'DIRECT' || rule.proxy === 'REJECT' ? 'var(--text-dim)' : 'var(--accent)' }}>
                    {rule.proxy || '—'}
                  </td>
                </tr>
              ))}
            </ScrollTable>
          </div>
          </>
        )}

            {tab === 'nodes' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0 }}>
            <div className="card-header">
              <div className="card-title"><span>{t('proxy.tabNodes')}</span></div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn btn-sm btn-primary" disabled={nodeBusy} onClick={() => void addNode()}>
                  <Plus size={13} />
                  <span>{t('proxy.nodeAdd')}</span>
                </button>
                <button className="btn btn-sm" disabled={busy !== null} onClick={() => void testAll()}>
                  {busy === 'test-all' && <Loader2 size={12} style={SPIN} />}
                  <span>{t('proxy.nodeTestAll')}</span>
                </button>
              </div>
            </div>
            {!coreReady && <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.notRunning')}</div>}
            {nodes.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 'var(--text-sm)' }}>{t('proxy.nodeEmpty')}</div>}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 220 }}>
                <Combobox
                  value={group}
                  onChange={value => {
                    setGroup(value);
                    void refreshNodes(value).catch(toastFailure);
                  }}
                  options={(groups.length ? groups : [{ name: group, type: 'Selector', now: '', all: [] }]).map(item => ({ value: item.name, label: item.name, meta: item.type }))}
                />
              </div>
              {sourceOptions.length > 1 && (
                <div style={{ minWidth: 200 }}>
                  <Combobox
                    value={sourceFilter}
                    onChange={setSourceFilter}
                    options={[
                      { value: '', label: t('proxy.nodeAllSources'), meta: String(nodes.length) },
                      ...sourceOptions.map(option => ({
                        value: option.key,
                        label: option.label,
                        meta: String(option.count),
                      })),
                    ]}
                  />
                </div>
              )}
              {typeOptions.length > 1 && (
                <div style={{ minWidth: 160 }}>
                  <Combobox
                    value={activeType}
                    onChange={setTypeFilter}
                    options={[
                      { value: '', label: t('proxy.nodeAllTypes'), meta: String(sourceFilter ? nodes.filter(node => nodeSourceKey(node.source) === sourceFilter).length : nodes.length) },
                      ...typeOptions.map(option => ({ value: option.type, label: option.type, meta: String(option.count) })),
                    ]}
                  />
                </div>
              )}
              <SearchInput value={query} onChange={setQuery} placeholder={t('proxy.nodeSearch')} />
            </div>
            {/* Every sibling column is nowrap or a fixed-width control, so without a
                floor the auto layout dumps all shrinkage on the node name and it wraps
                one character per line on a narrow screen (ScrollTable scrolls sideways
                below this width instead). 240px for the name is the readable minimum. */}
            <ScrollTable
              fill
              minWidth={900}
              columns={[
                { key: 'name', label: t('proxy.subName') },
                { key: 'type', label: t('proxy.nodeType'), width: 120 },
                { key: 'source', label: t('proxy.nodeSource'), width: 140 },
                {
                  key: 'delay',
                  label: (
                    <button
                      type="button"
                      className="th-sort"
                      onClick={() => setDelaySort(prev => (prev === 'asc' ? 'desc' : 'asc'))}
                      title={t('proxy.nodeSortDelay')}
                      aria-label={t('proxy.nodeSortDelay')}
                    >
                      <span>{t('proxy.nodeTest')}</span>
                      {delaySort === 'asc' ? <ArrowUp size={11} /> : delaySort === 'desc' ? <ArrowDown size={11} /> : <ArrowUpDown size={11} />}
                    </button>
                  ),
                  width: 100,
                },
                { key: 'state', label: t('proxy.nodeSelected'), width: 90 },
                { key: 'actions', label: '', width: 300 },
              ]}
              empty={query ? t('common.noResults') : undefined}
            >
              {sortedNodes.map(node => {
                const reading = readingOf(node);
                return (
                <tr
                  key={node.name}
                  className={node.selected ? 'is-current' : undefined}
                  ref={node.selected ? currentRowRef : undefined}
                >
                  <td style={{ padding: '8px 10px', ...(node.selected ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : {}) }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                      {node.selected && (
                        <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--accent-emerald)', display: 'inline-block' }} />
                      )}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-dim)' }}>{node.name === 'DIRECT' ? t('proxy.direct') : node.type}</td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sourceLabel(node.source)}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                      color: delayColor(reading),
                      fontWeight: node.selected ? 'var(--font-semibold)' : undefined,
                    }}>
                      {reading.state === 'testing' && <Loader2 size={11} style={SPIN} />}
                      {reading.state === 'measured'
                        ? t('proxy.nodeDelay', { ms: reading.ms ?? 0 })
                        : reading.state === 'testing' ? t('proxy.nodeTesting')
                          : reading.state === 'timeout' ? t('proxy.nodeOffline')
                            : reading.state === 'error' ? t('proxy.nodeError')
                              : '—'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px' }}>{node.selected ? <span className="badge badge-success">{t('proxy.nodeSelected')}</span> : <span style={{ color: 'var(--text-dim)' }} />}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                      <button
                        className="btn btn-sm"
                        disabled={busy !== null || node.selected || groupType !== 'select'}
                        title={groupType === 'select' ? undefined : t('proxy.nodePickAuto')}
                        onClick={() => void selectNode(node.name)}
                      >{t('proxy.nodeSelect')}</button>
                      <button className="btn btn-sm" disabled={busy !== null} onClick={() => void testNode(node.name)}>
                        {busy === `test:${node.name}` && <Loader2 size={12} style={SPIN} />}
                        <span>{t('proxy.nodeTest')}</span>
                      </button>
                      {node.manualId && (
                        <>
                          <button className="btn btn-sm" disabled={nodeBusy} onClick={() => void editNode(node.manualId!)}>{t('proxy.subEdit')}</button>
                          <button
                            className="btn btn-sm"
                            disabled={nodeBusy}
                            onClick={() => {
                              const manual = (mihomo.manualNodes ?? []).find(item => item.id === node.manualId);
                              if (manual) void removeNode(manual);
                            }}
                          >{t('common.delete')}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </ScrollTable>
              {nodeDialog && (
                <Dialog
                  title={nodeDialog.id ? t('proxy.nodeEdit') : t('proxy.nodeAdd')}
                  closeLabel={t('common.close')}
                  onClose={() => { if (!nodeBusy) setNodeDialog(null); }}
                  closeDisabled={nodeBusy}
                  width={560}
                  footerLeft={
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        className="btn"
                        disabled={nodeBusy || nodeTest.state === 'running' || (nodeDialog.mode === 'yaml'
                          ? !nodeDialog.yaml.trim()
                          : !nodeDialog.server.trim() || !Number(nodeDialog.port))}
                        onClick={() => void probeNodeDraft()}
                        style={{ flexShrink: 0, minWidth: 112, justifyContent: 'center', whiteSpace: 'nowrap' }}
                      >
                        {nodeTest.state === 'running' && <Loader2 size={12} style={SPIN} />}
                        <span>{nodeTest.state === 'running' ? t('proxy.nodeTesting') : t('proxy.nodeTestConn')}</span>
                      </button>
                      {nodeTest.state === 'ok' && (
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-emerald)' }}>{t('proxy.nodeTestOk', { ms: nodeTest.ms ?? 0 })}</span>
                      )}
                      {nodeTest.state === 'fail' && (
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>{t('proxy.nodeTestFail', { error: nodeTest.error ?? '' })}</span>
                      )}
                    </div>
                  }
                  footerRight={
                    <>
                      <button className="btn" disabled={nodeBusy} onClick={() => setNodeDialog(null)}>{t('common.cancel')}</button>
                      <button className="btn btn-primary" disabled={nodeBusy || !nodeSubmittable} onClick={() => void saveNode()}>
                        {t('common.save')}
                      </button>
                    </>
                  }
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <SegGroup
                      value={nodeDialog.mode}
                      onChange={value => patchNodeDraft({ mode: value as 'form' | 'yaml' })}
                      options={[
                        { value: 'form', label: t('proxy.nodeModeForm') },
                        { value: 'yaml', label: t('proxy.nodeModeYaml') },
                      ]}
                    />
                    {nodeDialog.mode === 'yaml' ? (
                      <div>
                        <label style={fieldLabel}>{t('proxy.nodeModeYaml')}</label>
                        <textarea
                          className="input"
                          value={nodeDialog.yaml}
                          onChange={e => patchNodeDraft({ yaml: e.target.value })}
                          rows={12}
                          spellCheck={false}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', resize: 'vertical', lineHeight: 'var(--leading-normal)' }}
                          placeholder={'- name: "node-1"\n  type: vless\n  server: example.com\n  port: 443\n  uuid: 00000000-0000-0000-0000-000000000000'}
                        />
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginTop: '6px', lineHeight: 'var(--leading-normal)' }}>{t('proxy.nodeYamlHint')}</div>
                      </div>
                    ) : (
                    <>
                    {nodeFieldError && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-rose)' }}>{nodeFieldError.message}</div>
                    )}
                    {nodeDialog.unmodeled.length > 0 && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>
                        {t('proxy.nodeUnmodeled', { keys: nodeDialog.unmodeled.join(', ') })}
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px' }}>
                      <div>
                        <label style={fieldLabel}>{t('proxy.subName')}</label>
                        <input className="input" value={nodeDialog.name} onChange={e => patchNodeDraft({ name: e.target.value })} />
                      </div>
                      <div>
                        <label style={fieldLabel}>{t('proxy.nodeType')}</label>
                        {rawNodeForm ? (
                          <input className="input" value={nodeDialog.type} disabled />
                        ) : (
                          <Combobox
                            value={nodeDialog.type}
                            onChange={value => patchNodeDraft({ type: value as MihomoManualNodeType })}
                            options={optionList(nodeCatalog?.protocols)}
                          />
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '8px' }}>
                      <div>
                        <label style={fieldLabel}>{t('proxy.nodeServer')}</label>
                        <input className="input" value={nodeDialog.server} onChange={e => patchNodeDraft({ server: e.target.value })} placeholder="example.com" />
                      </div>
                      <div>
                        <label style={fieldLabel}>{t('proxy.nodePort')}</label>
                        <input className="input" type="number" value={nodeDialog.port} onChange={e => patchNodeDraft({ port: e.target.value })} />
                      </div>
                    </div>
                    {!rawNodeForm && (
                    <>
                    {nodeDialog.type === 'ss' && (
                      <>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodeCipher')}</label>
                          <Combobox value={nodeDialog.cipher} onChange={value => patchNodeDraft({ cipher: value })} options={optionList(nodeCatalog?.enums.ssCiphers)} />
                        </div>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodePassword')}</label>
                          <input className="input" type="password" autoComplete="off" value={nodeDialog.password} onChange={e => patchNodeDraft({ password: e.target.value })} />
                        </div>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodePlugin')}</label>
                          <Combobox
                            value={nodeDialog.plugin}
                            onChange={value => patchNodeDraft({ plugin: value, pluginMode: '', pluginHost: '', pluginPath: '' })}
                            options={[{ value: '', label: t('proxy.nodeOptionNone') }, ...optionList(nodeCatalog?.enums.ssPlugins)]}
                          />
                        </div>
                        {nodeDialog.plugin === 'obfs' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodePluginMode')}</label>
                              <Combobox value={nodeDialog.pluginMode} onChange={value => patchNodeDraft({ pluginMode: value })} options={optionList(nodeCatalog?.enums.obfsModes)} />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodePluginHost')}</label>
                              <input className="input" value={nodeDialog.pluginHost} onChange={e => patchNodeDraft({ pluginHost: e.target.value })} placeholder="example.com" />
                            </div>
                          </div>
                        )}
                        {nodeDialog.plugin === 'v2ray-plugin' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodePluginHost')}</label>
                              <input className="input" value={nodeDialog.pluginHost} onChange={e => patchNodeDraft({ pluginHost: e.target.value })} placeholder="example.com" />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodePluginPath')}</label>
                              <input className="input" value={nodeDialog.pluginPath} onChange={e => patchNodeDraft({ pluginPath: e.target.value })} placeholder="/" />
                            </div>
                          </div>
                        )}
                        {nodeDialog.plugin === 'v2ray-plugin' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Switch checked={nodeDialog.pluginTls} onChange={value => patchNodeDraft({ pluginTls: value })} ariaLabel={t('proxy.nodePluginTls')} />
                            <span style={{ fontSize: 'var(--text-sm)' }}>{t('proxy.nodePluginTls')}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Switch checked={nodeDialog.udp} onChange={value => patchNodeDraft({ udp: value })} ariaLabel={t('proxy.nodeUdp')} />
                          <span style={{ fontSize: 'var(--text-sm)' }}>{t('proxy.nodeUdp')}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px', alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.tfo} onChange={value => patchNodeDraft({ tfo: value })} ariaLabel={t('proxy.nodeTfo')} />
                            <span>{t('proxy.nodeTfo')}</span>
                          </label>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeIpVersion')}</label>
                            <Combobox
                              value={nodeDialog.ipVersion}
                              onChange={value => patchNodeDraft({ ipVersion: value })}
                              options={[{ value: '', label: t('proxy.nodeOptionNone') }, ...optionList(nodeCatalog?.enums.ipVersions)]}
                            />
                          </div>
                        </div>
                      </>
                    )}
                    {(nodeDialog.type === 'vmess' || nodeDialog.type === 'vless') && (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeUuid')}</label>
                            <input className="input" value={nodeDialog.uuid} onChange={e => patchNodeDraft({ uuid: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeNetwork')}</label>
                            <Combobox
                              value={nodeDialog.network}
                              onChange={value => patchNodeDraft({ network: value as NodeDraft['network'] })}
                              options={optionList(nodeCatalog?.enums.networks)}
                            />
                          </div>
                        </div>
                        {nodeDialog.type === 'vmess' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeAlterId')}</label>
                              <input className="input" type="number" value={nodeDialog.alterId} onChange={e => patchNodeDraft({ alterId: e.target.value })} />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeVmessCipher')}</label>
                              <Combobox value={nodeDialog.vmessCipher} onChange={value => patchNodeDraft({ vmessCipher: value })} options={optionList(nodeCatalog?.enums.vmessCiphers)} />
                            </div>
                          </div>
                        )}
                        {nodeDialog.type === 'vless' && (
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeFlow')}</label>
                            <input className="input" value={nodeDialog.flow} onChange={e => patchNodeDraft({ flow: e.target.value })} placeholder="xtls-rprx-vision" />
                          </div>
                        )}
                        {nodeDialog.network === 'ws' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeWsPath')}</label>
                              <input className="input" value={nodeDialog.wsPath} onChange={e => patchNodeDraft({ wsPath: e.target.value })} placeholder="/" />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeWsHost')}</label>
                              <input className="input" value={nodeDialog.wsHost} onChange={e => patchNodeDraft({ wsHost: e.target.value })} placeholder="example.com" />
                            </div>
                          </div>
                        )}
                        {nodeDialog.network === 'grpc' && (
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeGrpcService')}</label>
                            <input className="input" value={nodeDialog.grpcServiceName} onChange={e => patchNodeDraft({ grpcServiceName: e.target.value })} />
                          </div>
                        )}
                        {nodeDialog.network === 'h2' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeH2Host')}</label>
                              <input className="input" value={nodeDialog.h2Host} onChange={e => patchNodeDraft({ h2Host: e.target.value })} placeholder="example.com" />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeH2Path')}</label>
                              <input className="input" value={nodeDialog.h2Path} onChange={e => patchNodeDraft({ h2Path: e.target.value })} placeholder="/" />
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Switch checked={nodeDialog.tls} onChange={value => patchNodeDraft({ tls: value })} ariaLabel={t('proxy.nodeTls')} />
                          <span style={{ fontSize: 'var(--text-sm)' }}>{t('proxy.nodeTls')}</span>
                        </div>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodeSni')}</label>
                          <input className="input" value={nodeDialog.sni} onChange={e => patchNodeDraft({ sni: e.target.value })} placeholder="example.com" />
                        </div>
                        {nodeDialog.type === 'vless' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeRealityPublicKey')}</label>
                              <input className="input" value={nodeDialog.realityPublicKey} onChange={e => patchNodeDraft({ realityPublicKey: e.target.value })} placeholder="REALITY public key" />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeRealityShortId')}</label>
                              <input className="input" value={nodeDialog.realityShortId} onChange={e => patchNodeDraft({ realityShortId: e.target.value })} placeholder="short-id" />
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeAlpn')}</label>
                            <input className="input" value={nodeDialog.alpn} onChange={e => patchNodeDraft({ alpn: e.target.value })} placeholder="h2, http/1.1" />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeFingerprint')}</label>
                            <Combobox value={nodeDialog.clientFingerprint} onChange={value => patchNodeDraft({ clientFingerprint: value })} options={optionList(nodeCatalog?.enums.fingerprints)} />
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px', alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.tfo} onChange={value => patchNodeDraft({ tfo: value })} ariaLabel={t('proxy.nodeTfo')} />
                            <span>{t('proxy.nodeTfo')}</span>
                          </label>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeIpVersion')}</label>
                            <Combobox
                              value={nodeDialog.ipVersion}
                              onChange={value => patchNodeDraft({ ipVersion: value })}
                              options={[{ value: '', label: t('proxy.nodeOptionNone') }, ...optionList(nodeCatalog?.enums.ipVersions)]}
                            />
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.skipCertVerify} onChange={value => patchNodeDraft({ skipCertVerify: value })} ariaLabel={t('proxy.nodeSkipCertVerify')} />
                            <span>{t('proxy.nodeSkipCertVerify')}</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.udp} onChange={value => patchNodeDraft({ udp: value })} ariaLabel={t('proxy.nodeUdp')} />
                            <span>{t('proxy.nodeUdp')}</span>
                          </label>
                        </div>
                      </>
                    )}
                    {nodeDialog.type === 'trojan' && (
                      <>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodePassword')}</label>
                          <input className="input" type="password" autoComplete="off" value={nodeDialog.password} onChange={e => patchNodeDraft({ password: e.target.value })} />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeNetwork')}</label>
                            <Combobox
                              value={nodeDialog.network}
                              onChange={value => patchNodeDraft({ network: value as NodeDraft['network'] })}
                              options={optionList(nodeCatalog?.enums.networks).filter(option => option.value !== 'h2')}
                            />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeSni')}</label>
                            <input className="input" value={nodeDialog.sni} onChange={e => patchNodeDraft({ sni: e.target.value })} placeholder="example.com" />
                          </div>
                        </div>
                        {nodeDialog.network === 'ws' && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeWsPath')}</label>
                              <input className="input" value={nodeDialog.wsPath} onChange={e => patchNodeDraft({ wsPath: e.target.value })} placeholder="/" />
                            </div>
                            <div>
                              <label style={fieldLabel}>{t('proxy.nodeWsHost')}</label>
                              <input className="input" value={nodeDialog.wsHost} onChange={e => patchNodeDraft({ wsHost: e.target.value })} placeholder="example.com" />
                            </div>
                          </div>
                        )}
                        {nodeDialog.network === 'grpc' && (
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeGrpcService')}</label>
                            <input className="input" value={nodeDialog.grpcServiceName} onChange={e => patchNodeDraft({ grpcServiceName: e.target.value })} />
                          </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeAlpn')}</label>
                            <input className="input" value={nodeDialog.alpn} onChange={e => patchNodeDraft({ alpn: e.target.value })} placeholder="h2, http/1.1" />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeFingerprint')}</label>
                            <Combobox value={nodeDialog.clientFingerprint} onChange={value => patchNodeDraft({ clientFingerprint: value })} options={optionList(nodeCatalog?.enums.fingerprints)} />
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px', alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.tfo} onChange={value => patchNodeDraft({ tfo: value })} ariaLabel={t('proxy.nodeTfo')} />
                            <span>{t('proxy.nodeTfo')}</span>
                          </label>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeIpVersion')}</label>
                            <Combobox
                              value={nodeDialog.ipVersion}
                              onChange={value => patchNodeDraft({ ipVersion: value })}
                              options={[{ value: '', label: t('proxy.nodeOptionNone') }, ...optionList(nodeCatalog?.enums.ipVersions)]}
                            />
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.skipCertVerify} onChange={value => patchNodeDraft({ skipCertVerify: value })} ariaLabel={t('proxy.nodeSkipCertVerify')} />
                            <span>{t('proxy.nodeSkipCertVerify')}</span>
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.udp} onChange={value => patchNodeDraft({ udp: value })} ariaLabel={t('proxy.nodeUdp')} />
                            <span>{t('proxy.nodeUdp')}</span>
                          </label>
                        </div>
                      </>
                    )}
                    {nodeDialog.type === 'hysteria2' && (
                      <>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodePassword')}</label>
                          <input className="input" type="password" autoComplete="off" value={nodeDialog.password} onChange={e => patchNodeDraft({ password: e.target.value })} />
                        </div>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodeSni')}</label>
                          <input className="input" value={nodeDialog.sni} onChange={e => patchNodeDraft({ sni: e.target.value })} placeholder="example.com" />
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeObfs')}</label>
                            <Combobox
                              value={nodeDialog.obfs}
                              onChange={value => patchNodeDraft({ obfs: value, obfsPassword: '' })}
                              options={[{ value: '', label: t('proxy.nodeOptionNone') }, { value: 'salamander', label: 'salamander' }]}
                            />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeObfsPassword')}</label>
                            <input className="input" type="password" autoComplete="off" value={nodeDialog.obfsPassword} onChange={e => patchNodeDraft({ obfsPassword: e.target.value })} disabled={nodeDialog.obfs !== 'salamander'} />
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeUp')}</label>
                            <input className="input" value={nodeDialog.up} onChange={e => patchNodeDraft({ up: e.target.value })} placeholder="100 Mbps" />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeDown')}</label>
                            <input className="input" value={nodeDialog.down} onChange={e => patchNodeDraft({ down: e.target.value })} placeholder="100 Mbps" />
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodePorts')}</label>
                            <input className="input" value={nodeDialog.ports} onChange={e => patchNodeDraft({ ports: e.target.value })} placeholder="443,1000-2000" />
                          </div>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeIpVersion')}</label>
                            <Combobox
                              value={nodeDialog.ipVersion}
                              onChange={value => patchNodeDraft({ ipVersion: value })}
                              options={[{ value: '', label: t('proxy.nodeOptionNone') }, ...optionList(nodeCatalog?.enums.ipVersions)]}
                            />
                          </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px' }}>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeAlpn')}</label>
                            <input className="input" value={nodeDialog.alpn} onChange={e => patchNodeDraft({ alpn: e.target.value })} placeholder="h3" />
                          </div>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', paddingTop: '18px' }}>
                            <Switch checked={nodeDialog.skipCertVerify} onChange={value => patchNodeDraft({ skipCertVerify: value })} ariaLabel={t('proxy.nodeSkipCertVerify')} />
                            <span>{t('proxy.nodeSkipCertVerify')}</span>
                          </label>
                        </div>
                      </>
                    )}
                    {(nodeDialog.type === 'http' || nodeDialog.type === 'socks5') && (
                      <>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodeUsername')}</label>
                          <input className="input" autoComplete="off" value={nodeDialog.username} onChange={e => patchNodeDraft({ username: e.target.value })} />
                        </div>
                        <div>
                          <label style={fieldLabel}>{t('proxy.nodePassword')}</label>
                          <input className="input" type="password" autoComplete="off" value={nodeDialog.password} onChange={e => patchNodeDraft({ password: e.target.value })} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Switch checked={nodeDialog.tls} onChange={value => patchNodeDraft({ tls: value })} ariaLabel={t('proxy.nodeTls')} />
                          <span style={{ fontSize: 'var(--text-sm)' }}>{t('proxy.nodeTls')}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Switch checked={nodeDialog.skipCertVerify} onChange={value => patchNodeDraft({ skipCertVerify: value })} ariaLabel={t('proxy.nodeSkipCertVerify')} />
                          <span style={{ fontSize: 'var(--text-sm)' }}>{t('proxy.nodeSkipCertVerify')}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Switch checked={nodeDialog.udp} onChange={value => patchNodeDraft({ udp: value })} ariaLabel={t('proxy.nodeUdp')} />
                          <span style={{ fontSize: 'var(--text-sm)' }}>{t('proxy.nodeUdp')}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: '8px', alignItems: 'center' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                            <Switch checked={nodeDialog.tfo} onChange={value => patchNodeDraft({ tfo: value })} ariaLabel={t('proxy.nodeTfo')} />
                            <span>{t('proxy.nodeTfo')}</span>
                          </label>
                          <div>
                            <label style={fieldLabel}>{t('proxy.nodeIpVersion')}</label>
                            <Combobox
                              value={nodeDialog.ipVersion}
                              onChange={value => patchNodeDraft({ ipVersion: value })}
                              options={[{ value: '', label: t('proxy.nodeOptionNone') }, ...optionList(nodeCatalog?.enums.ipVersions)]}
                            />
                          </div>
                        </div>
                      </>
                    )}
                    </>
                    )}
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', lineHeight: 'var(--leading-normal)' }}>
                      {rawNodeForm ? t('proxy.nodeRawFormHint') : t('proxy.nodeHint')}
                    </div>
                    </>
                    )}
                  </div>
                </Dialog>
              )}
          </div>
        )}
          </div>
        </div>
    </div>
  );
};
