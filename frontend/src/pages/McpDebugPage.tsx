import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Compass,
  Copy,
  Download,
  FileText,
  Globe,
  History,
  Maximize2,
  MessageSquare,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  Unplug,
  Wrench,
  X,
} from 'lucide-react';
import {
  api,
  type HarnessHostView,
  type HarnessInstallTarget,
  type HarnessMcpLaunch,
  type McpCallToolResponse,
  type McpGetPromptResponse,
  type McpInspectSnapshot,
  type McpInspectTarget,
  type McpPromptInfo,
  type McpReadResourceResponse,
  type McpResourceInfo,
  type McpResourceTemplateInfo,
  type McpToolInfo,
  type ProjectItem,
} from '../lib/api';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { Dialog } from '../components/Dialog';
import { ProjectPicker, reconcileProjectSelection } from '../components/ProjectPicker';
import { ResultViewer } from '../components/ResultViewer';
import { SegGroup } from '../components/SegGroup';
import { SuggestInput } from '../components/SuggestInput';
import { useConfirm } from '../components/ConfirmProvider';
import { useToast } from '../components/ToastProvider';
import { useI18n } from '../i18n/I18nContext';
import { useTranslationCache, type TranslationItem } from '../hooks/useTranslationCache';
import { TranslateButton, TranslationBadge } from '../components/TranslationControls';

type TargetMode = 'host' | 'custom';
type CustomTransport = 'stdio' | 'auto' | 'streamable-http' | 'sse';
type CapabilityTab = 'tools' | 'resources' | 'prompts' | 'logs';
type InputMode = 'form' | 'json';

interface KeyValRow {
  key: string;
  value: string;
}

interface CallHistoryEntry {
  id: string;
  timestamp: number;
  args: Record<string, unknown>;
}

const HISTORY_STORAGE_KEY = 'ocr.mcpBrowser.history.v1';

const COMMON_HEADER_SUGGESTIONS = [
  'Authorization',
  'X-API-Key',
  'X-Auth-Token',
  'Accept',
  'Content-Type',
  'User-Agent',
  'X-Project-Id',
  'Cookie',
];

function estimateTokens(value: unknown): number {
  const chars = JSON.stringify(value)?.length ?? 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function schemaDefaults(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props || typeof props !== 'object') return {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    if (prop.default !== undefined) {
      out[key] = prop.default;
      continue;
    }
    if (!required.has(key)) continue;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      out[key] = prop.enum[0];
    } else if (prop.type === 'boolean') {
      out[key] = false;
    } else if (prop.type === 'number' || prop.type === 'integer') {
      out[key] = 0;
    } else if (prop.type === 'array') {
      out[key] = [];
    } else if (prop.type === 'object') {
      out[key] = {};
    } else {
      out[key] = '';
    }
  }
  return out;
}

function readHistoryMap(): Record<string, CallHistoryEntry[]> {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, CallHistoryEntry[]>)
      : {};
  } catch {
    return {};
  }
}

function writeHistoryMap(next: Record<string, CallHistoryEntry[]>): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors.
  }
}

function splitShellArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function joinShellArgs(args: string[]): string {
  return args
    .map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
}

interface ParsedCustomConfig {
  name: string;
  transport: CustomTransport;
  command?: string;
  args?: string;
  cwd?: string;
  envRows?: KeyValRow[];
  url?: string;
  headerRows?: KeyValRow[];
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function toKeyValRows(obj: unknown): KeyValRow[] {
  if (!isPlainObj(obj)) return [];
  return Object.entries(obj)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([key, v]) => ({ key, value: String(v) }));
}

function parseMcpSnippet(rawText: string): ParsedCustomConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!isPlainObj(parsed)) return null;

  const extractServer = (name: string, entry: unknown): ParsedCustomConfig | null => {
    if (!isPlainObj(entry)) return null;
    if (typeof entry.url === 'string' && entry.url.trim()) {
      const rawType = typeof entry.type === 'string' ? entry.type.toLowerCase() : typeof entry.transport === 'string' ? entry.transport.toLowerCase() : 'auto';
      const transport: CustomTransport =
        rawType === 'sse' ? 'sse' : rawType === 'http' || rawType === 'streamable-http' ? 'streamable-http' : 'auto';
      const headersObj = isPlainObj(entry.headers)
        ? entry.headers
        : isPlainObj(entry.http_headers)
          ? entry.http_headers
          : undefined;
      return {
        name,
        transport,
        url: entry.url.trim(),
        headerRows: toKeyValRows(headersObj),
      };
    }
    if (Array.isArray(entry.command)) {
      const parts = entry.command.filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (parts.length === 0) return null;
      return {
        name,
        transport: 'stdio',
        command: parts[0]!,
        args: joinShellArgs(parts.slice(1)),
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        envRows: toKeyValRows(entry.environment ?? entry.env),
      };
    }
    if (typeof entry.command === 'string' && entry.command.trim()) {
      const argsList = Array.isArray(entry.args)
        ? entry.args.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        name,
        transport: 'stdio',
        command: entry.command.trim(),
        args: joinShellArgs(argsList),
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        envRows: toKeyValRows(entry.environment ?? entry.env),
      };
    }
    return null;
  };

  // Direct server object: { url, headers } or { command, args }
  const direct = extractServer('custom', parsed);
  if (direct) return direct;

  // Wrapped container: { mcpServers: { ... } } / { mcp_servers: { ... } } / { mcp: { servers?: { ... } } }
  const containerCandidates = [
    parsed.mcpServers,
    parsed.mcp_servers,
    isPlainObj(parsed.mcp) && isPlainObj(parsed.mcp.servers) ? parsed.mcp.servers : parsed.mcp,
    parsed,
  ];
  for (const candidate of containerCandidates) {
    if (!isPlainObj(candidate)) continue;
    for (const [key, val] of Object.entries(candidate)) {
      const hit = extractServer(key, val);
      if (hit) return hit;
    }
  }
  return null;
}

function schemaTypeLabel(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) return `enum(${prop.enum.length})`;
  if (Array.isArray(prop.type)) return prop.type.join(' | ');
  if (typeof prop.type === 'string') return prop.type;
  if (Array.isArray(prop.anyOf)) return 'anyOf';
  if (Array.isArray(prop.oneOf)) return 'oneOf';
  return 'any';
}

export const McpDebugPage: React.FC = () => {
  const { t } = useI18n();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    lang,
    batch: translationBatch,
    seed: seedTranslations,
    translateOne: translateDesc,
    translateAll: translateAllDescs,
    toggleOriginal,
    getDisplay: getTranslationDisplay,
  } = useTranslationCache();

  // Target selection state
  const [mode, setMode] = useState<TargetMode>('host');
  const [hosts, setHosts] = useState<HarnessHostView[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedHost, setSelectedHost] = useState<string>('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [hostServers, setHostServers] = useState<string[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [selectedServer, setSelectedServer] = useState<string>('');

  // Custom target state
  const [customTransport, setCustomTransport] = useState<CustomTransport>('stdio');
  const [customCommand, setCustomCommand] = useState<string>('');
  const [customArgs, setCustomArgs] = useState<string>('');
  const [customCwd, setCustomCwd] = useState<string>('');
  const [customUrl, setCustomUrl] = useState<string>('');
  const [customEnvRows, setCustomEnvRows] = useState<KeyValRow[]>([]);
  const [customHeaderRows, setCustomHeaderRows] = useState<KeyValRow[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState('');
  const [customNameHint, setCustomNameHint] = useState('');

  // Install-to-host dialog state
  const [installOpen, setInstallOpen] = useState(false);
  const [installName, setInstallName] = useState('');
  const [installHosts, setInstallHosts] = useState<string[]>([]);
  const [installScope, setInstallScope] = useState<'global' | 'project'>('global');
  const [installProjectId, setInstallProjectId] = useState('');
  const [installPlan, setInstallPlan] = useState<HarnessInstallTarget[] | null>(null);
  const [installBusy, setInstallBusy] = useState(false);

  // Active inspection session state
  const [connecting, setConnecting] = useState(false);
  const [snapshot, setSnapshot] = useState<McpInspectSnapshot | null>(null);
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [workspaceFullscreen, setWorkspaceFullscreen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<McpInspectTarget | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CapabilityTab>('tools');
  const [filterText, setFilterText] = useState('');
  const [timeoutMs, setTimeoutMs] = useState<number>(30000);

  // Selected item state
  const [selectedToolName, setSelectedToolName] = useState<string>('');
  const [selectedResourceUri, setSelectedResourceUri] = useState<string>('');
  const [resourceUriDraft, setResourceUriDraft] = useState<string>('');
  const [selectedIsTemplate, setSelectedIsTemplate] = useState(false);
  const [selectedPromptName, setSelectedPromptName] = useState<string>('');

  // Tool call state
  const [inputMode, setInputMode] = useState<InputMode>('form');
  const [toolFormValues, setToolFormValues] = useState<Record<string, unknown>>({});
  const [toolJsonText, setToolJsonText] = useState<string>('{}');
  const [toolJsonError, setToolJsonError] = useState<string | null>(null);
  const [calling, setCalling] = useState(false);
  const [toolResult, setToolResult] = useState<McpCallToolResponse | null>(null);
  const [resultOpen, setResultOpen] = useState(true);
  const [historyMap, setHistoryMap] = useState<Record<string, CallHistoryEntry[]>>(() => readHistoryMap());

  // Resource & Prompt call state
  const [readingResource, setReadingResource] = useState(false);
  const [resourceResult, setResourceResult] = useState<McpReadResourceResponse | null>(null);
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [gettingPrompt, setGettingPrompt] = useState(false);
  const [promptResult, setPromptResult] = useState<McpGetPromptResponse | null>(null);

  const autoConnectRanRef = useRef(false);

  // Exit fullscreen on Escape key.
  useEffect(() => {
    if (!workspaceFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkspaceFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceFullscreen]);

  // Load MCP-capable hosts and project list on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [hostsRes, projRes] = await Promise.all([api.harnessHosts(), api.listProjects()]);
        if (cancelled) return;
        const mcpHosts = (hostsRes.hosts ?? []).filter((h) => h.hasMcp);
        setHosts(mcpHosts);
        const projItems = projRes.projects ?? [];
        setProjects(projItems);

        const qHost = searchParams.get('host');
        const qScope = searchParams.get('scope') === 'project' ? 'project' : 'global';
        const qProjectId = searchParams.get('projectId') ?? '';
        const qName = searchParams.get('name') ?? '';

        if (qHost && mcpHosts.some((h) => h.id === qHost)) {
          setSelectedHost(qHost);
        } else if (mcpHosts.length > 0) {
          const detected = mcpHosts.find((h) => h.detected) ?? mcpHosts[0]!;
          setSelectedHost(detected.id);
        }

        setScope(qScope);
        if (qProjectId && projItems.some((p) => p.id === qProjectId)) {
          setSelectedProjectId(qProjectId);
        } else if (projItems.length > 0) {
          setSelectedProjectId(projItems[0]!.id);
        }
        if (qName) {
          setSelectedServer(qName);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh installed MCP server names when host / scope / project changes.
  useEffect(() => {
    if (!selectedHost) {
      setHostServers([]);
      return;
    }
    if (scope === 'project' && !selectedProjectId) {
      setHostServers([]);
      return;
    }
    let cancelled = false;
    setLoadingServers(true);
    void (async () => {
      try {
        const inv = await api.harnessInventory(
          scope === 'project' && selectedProjectId ? { projectId: selectedProjectId } : undefined
        );
        if (cancelled) return;
        const names = new Set<string>();
        for (const item of inv.discovered ?? []) {
          if (item.kind === 'mcp' && item.hosts.includes(selectedHost)) names.add(item.name);
        }
        for (const item of inv.artifacts ?? []) {
          if (item.kind === 'mcp' && item.copies.some((c) => c.host === selectedHost)) names.add(item.name);
        }
        const sorted = [...names].sort((a, b) => a.localeCompare(b));
        setHostServers(sorted);
        setSelectedServer((prev) => (prev && sorted.includes(prev) ? prev : sorted[0] ?? ''));
      } catch {
        if (!cancelled) setHostServers([]);
      } finally {
        if (!cancelled) setLoadingServers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedHost, scope, selectedProjectId]);

  const buildTarget = useCallback((): McpInspectTarget | null => {
    if (mode === 'host') {
      if (!selectedHost || !selectedServer) return null;
      return {
        mode: 'host',
        host: selectedHost,
        scope,
        name: selectedServer,
        ...(scope === 'project' && selectedProjectId ? { projectId: selectedProjectId } : {}),
      };
    }
    if (customTransport === 'stdio') {
      if (!customCommand.trim()) return null;
      const env = Object.fromEntries(
        customEnvRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
      );
      return {
        mode: 'custom',
        transport: 'stdio',
        command: customCommand.trim(),
        args: splitShellArgs(customArgs),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(customCwd.trim() ? { cwd: customCwd.trim() } : {}),
      };
    }
    if (!customUrl.trim()) return null;
    const headers = Object.fromEntries(
      customHeaderRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])
    );
    return {
      mode: 'custom',
      transport: customTransport,
      url: customUrl.trim(),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }, [
    mode,
    selectedHost,
    selectedServer,
    scope,
    selectedProjectId,
    customTransport,
    customCommand,
    customArgs,
    customEnvRows,
    customCwd,
    customUrl,
    customHeaderRows,
  ]);

  const runInspect = useCallback(
    async (target: McpInspectTarget, refresh = false) => {
      setConnecting(true);
      try {
        const res = await api.harnessMcpInspect({ target, refresh });
        setSnapshot(res);
        setActiveTarget(target);
        setConfigCollapsed(true);
        setToolResult(null);
        setResourceResult(null);
        setPromptResult(null);

        if (res.tools.length > 0) {
          setActiveTab('tools');
          setSelectedToolName(res.tools[0]!.name);
        } else if (res.resources.length > 0 || res.resourceTemplates.length > 0) {
          setActiveTab('resources');
        } else if (res.prompts.length > 0) {
          setActiveTab('prompts');
        } else if (res.stderr.length > 0) {
          setActiveTab('logs');
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setConnecting(false);
      }
    },
    [toast]
  );

  // Auto-connect once when navigated with ?host=...&name=...
  useEffect(() => {
    if (autoConnectRanRef.current) return;
    const qHost = searchParams.get('host');
    const qName = searchParams.get('name');
    if (!qHost || !qName) return;
    if (selectedHost !== qHost || selectedServer !== qName) return;
    if (scope === 'project' && !selectedProjectId) return;
    autoConnectRanRef.current = true;
    const target = buildTarget();
    if (target) {
      void runInspect(target, false);
      // Clear query params after consuming them so refresh stays clean.
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, selectedHost, selectedServer, scope, selectedProjectId, buildTarget, runInspect, setSearchParams]);

  const buildCustomLaunch = useCallback((): HarnessMcpLaunch | null => {
    if (customTransport === 'stdio') {
      if (!customCommand.trim()) return null;
      const args = splitShellArgs(customArgs);
      const envEntries = customEnvRows.filter((r) => r.key.trim());
      const envKeys = envEntries.map((r) => r.key.trim());
      const envValues = Object.fromEntries(envEntries.filter((r) => r.value !== '').map((r) => [r.key.trim(), r.value]));
      return {
        command: customCommand.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(envKeys.length > 0 ? { envKeys } : {}),
        ...(Object.keys(envValues).length > 0 ? { envValues } : {}),
      };
    }
    if (!customUrl.trim()) return null;
    const headerEntries = customHeaderRows.filter((r) => r.key.trim());
    const headerKeys = headerEntries.map((r) => r.key.trim());
    const headerValues = Object.fromEntries(
      headerEntries.filter((r) => r.value !== '').map((r) => [r.key.trim(), r.value])
    );
    return {
      url: customUrl.trim(),
      transport: customTransport === 'sse' ? 'sse' : 'http',
      ...(headerKeys.length > 0 ? { headerKeys } : {}),
      ...(Object.keys(headerValues).length > 0 ? { headerValues } : {}),
    };
  }, [customTransport, customCommand, customArgs, customEnvRows, customUrl, customHeaderRows]);

  const openInstallDialog = useCallback(() => {
    const defaultName = (customNameHint || snapshot?.serverInfo?.name || 'mcp-server')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mcp-server';
    setInstallName(defaultName);
    setInstallScope(scope);
    setInstallProjectId(selectedProjectId || projects[0]?.id || '');
    setInstallHosts([]);
    setInstallPlan(null);
    setInstallOpen(true);
  }, [customNameHint, snapshot, scope, selectedProjectId, projects]);

  const submitInstall = async (confirm: boolean) => {
    const launch = buildCustomLaunch();
    const name = installName.trim();
    if (!launch || !name) return;
    if (installHosts.length === 0) {
      toast.error(t('mcpBrowser.installNoHosts'));
      return;
    }
    const projRoot =
      installScope === 'project'
        ? projects.find((p) => p.id === installProjectId)?.path
        : undefined;
    setInstallBusy(true);
    try {
      await api.harnessInstall({
        kind: 'mcp',
        manualPayload: { name, launch },
        hosts: installHosts,
        scope: installScope,
        ...(projRoot ? { projectRoot: projRoot } : {}),
        confirm,
      });
      toast.success(t('mcpBrowser.installSuccess', { name, count: installHosts.length }));
      setInstallOpen(false);
      setInstallPlan(null);
    } catch (err) {
      const e = err as Error & { code?: string; plan?: HarnessInstallTarget[] };
      if (e.code === 'confirm_required' && Array.isArray(e.plan)) {
        setInstallPlan(e.plan);
      } else {
        toast.error(e.message || String(err));
      }
    } finally {
      setInstallBusy(false);
    }
  };

  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t('common.copied'));
      } catch {
        toast.error(t('common.copyFailed'));
      }
    },
    [t, toast]
  );

  const handleDisconnect = async () => {
    if (!snapshot) return;
    try {
      await api.harnessMcpDisconnect(snapshot.sessionId);
    } catch {
      // Ignore disconnect errors.
    }
    setSnapshot(null);
    setActiveTarget(null);
    setConfigCollapsed(false);
    setWorkspaceFullscreen(false);
    setToolResult(null);
    setResourceResult(null);
    setPromptResult(null);
  };

  const selectedTool: McpToolInfo | null = useMemo(
    () => snapshot?.tools.find((item) => item.name === selectedToolName) ?? null,
    [snapshot, selectedToolName]
  );

  const selectedPrompt: McpPromptInfo | null = useMemo(
    () => snapshot?.prompts.find((item) => item.name === selectedPromptName) ?? null,
    [snapshot, selectedPromptName]
  );

  // Reset tool arguments when selected tool changes.
  useEffect(() => {
    if (!selectedTool) return;
    const defaults = schemaDefaults(selectedTool.inputSchema);
    setToolFormValues(defaults);
    setToolJsonText(JSON.stringify(defaults, null, 2));
    setToolJsonError(null);
    setToolResult(null);
  }, [selectedTool]);

  useEffect(() => {
    if (!selectedPrompt) return;
    const init: Record<string, string> = {};
    for (const arg of selectedPrompt.arguments ?? []) {
      init[arg.name] = '';
    }
    setPromptArgs(init);
    setPromptResult(null);
  }, [selectedPrompt]);

  const serverHistoryKey = useMemo(() => {
    const serverLabel =
      snapshot?.serverInfo?.name ||
      (activeTarget?.mode === 'host' ? activeTarget.name : activeTarget?.mode === 'custom' ? 'custom' : '');
    return serverLabel && selectedTool ? `${serverLabel}::${selectedTool.name}` : '';
  }, [snapshot, activeTarget, selectedTool]);

  const toolHistory = useMemo(
    () => (serverHistoryKey ? historyMap[serverHistoryKey] ?? [] : []),
    [historyMap, serverHistoryKey]
  );

  const recordToolHistory = (args: Record<string, unknown>) => {
    if (!serverHistoryKey) return;
    const serialized = JSON.stringify(args);
    const existing = historyMap[serverHistoryKey] ?? [];
    const deduped = existing.filter((e) => JSON.stringify(e.args) !== serialized);
    const nextList: CallHistoryEntry[] = [
      { id: `${Date.now()}`, timestamp: Date.now(), args },
      ...deduped,
    ].slice(0, 10);
    const nextMap = { ...historyMap, [serverHistoryKey]: nextList };
    setHistoryMap(nextMap);
    writeHistoryMap(nextMap);
  };

  const handleRunTool = async () => {
    if (!snapshot || !selectedTool || calling) return;
    let parsedArgs: Record<string, unknown> = toolFormValues;
    if (inputMode === 'json') {
      try {
        const parsed = JSON.parse(toolJsonText || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setToolJsonError(t('mcpBrowser.invalidJson'));
          return;
        }
        parsedArgs = parsed as Record<string, unknown>;
        setToolJsonError(null);
      } catch {
        setToolJsonError(t('mcpBrowser.invalidJson'));
        return;
      }
    }
    setCalling(true);
    try {
      const res = await api.harnessMcpCallTool({
        sessionId: snapshot.sessionId,
        ...(activeTarget ? { target: activeTarget } : {}),
        toolName: selectedTool.name,
        arguments: parsedArgs,
        timeoutMs,
      });
      setToolResult(res);
      setResultOpen(true);
      setSnapshot((prev) => (prev ? { ...prev, sessionId: res.sessionId, stderr: res.stderr } : prev));
      recordToolHistory(parsedArgs);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCalling(false);
    }
  };

  const handleReadResource = async () => {
    if (!snapshot || !resourceUriDraft.trim() || readingResource) return;
    setReadingResource(true);
    try {
      const res = await api.harnessMcpReadResource({
        sessionId: snapshot.sessionId,
        ...(activeTarget ? { target: activeTarget } : {}),
        uri: resourceUriDraft.trim(),
        timeoutMs,
      });
      setResourceResult(res);
      setSnapshot((prev) => (prev ? { ...prev, sessionId: res.sessionId, stderr: res.stderr } : prev));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setReadingResource(false);
    }
  };

  const handleGetPrompt = async () => {
    if (!snapshot || !selectedPrompt || gettingPrompt) return;
    setGettingPrompt(true);
    try {
      const res = await api.harnessMcpGetPrompt({
        sessionId: snapshot.sessionId,
        ...(activeTarget ? { target: activeTarget } : {}),
        promptName: selectedPrompt.name,
        arguments: promptArgs,
        timeoutMs,
      });
      setPromptResult(res);
      setSnapshot((prev) => (prev ? { ...prev, sessionId: res.sessionId, stderr: res.stderr } : prev));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setGettingPrompt(false);
    }
  };

  const syncFormValue = (key: string, value: unknown) => {
    setToolFormValues((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      setToolJsonText(JSON.stringify(next, null, 2));
      setToolJsonError(null);
      return next;
    });
  };

  const switchInputMode = (nextMode: InputMode) => {
    if (nextMode === inputMode) return;
    if (nextMode === 'json') {
      setToolJsonText(JSON.stringify(toolFormValues, null, 2));
      setToolJsonError(null);
      setInputMode('json');
    } else {
      try {
        const parsed = JSON.parse(toolJsonText || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setToolFormValues(parsed as Record<string, unknown>);
          setToolJsonError(null);
          setInputMode('form');
        } else {
          setToolJsonError(t('mcpBrowser.invalidJson'));
        }
      } catch {
        setToolJsonError(t('mcpBrowser.invalidJson'));
      }
    }
  };

  const hostOptions: ComboboxOption[] = useMemo(
    () =>
      hosts.map((h) => ({
        value: h.id,
        label: h.label,
        ...(h.detected ? { meta: 'detected' } : {}),
      })),
    [hosts]
  );

  const scopeOptions: ComboboxOption[] = useMemo(
    () => [
      { value: 'global', label: t('mcpBrowser.scopeGlobal') },
      { value: 'project', label: t('mcpBrowser.scopeProject') },
    ],
    [t]
  );

  const handleProjectsChange = useCallback((updatedProjects: ProjectItem[], updatedActiveId: string | null) => {
    setProjects(updatedProjects);
    setSelectedProjectId((prev) => reconcileProjectSelection(prev, updatedProjects, updatedActiveId));
    setInstallProjectId((prev) => reconcileProjectSelection(prev, updatedProjects, updatedActiveId));
    setInstallPlan(null);
  }, []);

  const serverOptions: ComboboxOption[] = useMemo(
    () => hostServers.map((s) => ({ value: s, label: s })),
    [hostServers]
  );

  const transportOptions: ComboboxOption[] = useMemo(
    () => [
      { value: 'stdio', label: t('mcpBrowser.transportStdio') },
      { value: 'auto', label: t('mcpBrowser.transportAuto') },
      { value: 'streamable-http', label: t('mcpBrowser.transportStreamableHttp') },
      { value: 'sse', label: t('mcpBrowser.transportSse') },
    ],
    [t]
  );

  const q = filterText.trim().toLowerCase();
  const filteredTools = useMemo(() => {
    if (!snapshot) return [];
    if (!q) return snapshot.tools;
    return snapshot.tools.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.description ?? '').toLowerCase().includes(q)
    );
  }, [snapshot, q]);

  const filteredResources = useMemo(() => {
    if (!snapshot) return [];
    if (!q) return snapshot.resources;
    return snapshot.resources.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.uri.toLowerCase().includes(q) ||
        (item.description ?? '').toLowerCase().includes(q)
    );
  }, [snapshot, q]);

  const filteredTemplates = useMemo(() => {
    if (!snapshot) return [];
    if (!q) return snapshot.resourceTemplates;
    return snapshot.resourceTemplates.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.uriTemplate.toLowerCase().includes(q) ||
        (item.description ?? '').toLowerCase().includes(q)
    );
  }, [snapshot, q]);

  const filteredPrompts = useMemo(() => {
    if (!snapshot) return [];
    if (!q) return snapshot.prompts;
    return snapshot.prompts.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.description ?? '').toLowerCase().includes(q)
    );
  }, [snapshot, q]);

  const totalToolTokens = useMemo(
    () => (snapshot ? snapshot.tools.reduce((acc, item) => acc + estimateTokens(item), 0) : 0),
    [snapshot]
  );

  const translationItems = useMemo<TranslationItem[]>(() => {
    if (!snapshot) return [];
    const items: TranslationItem[] = [];
    if (snapshot.instructions) {
      items.push({ key: 'server:instructions', text: snapshot.instructions });
    }
    for (const tool of snapshot.tools) {
      if (tool.description) items.push({ key: `tool:${tool.name}`, text: tool.description });
      const props = (tool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
      for (const [propKey, prop] of Object.entries(props)) {
        if (prop && typeof prop.description === 'string' && prop.description) {
          items.push({ key: `tool:${tool.name}:arg:${propKey}`, text: prop.description });
        }
      }
    }
    for (const res of snapshot.resources) {
      if (res.description) items.push({ key: `resource:${res.uri}`, text: res.description });
    }
    for (const tpl of snapshot.resourceTemplates) {
      if (tpl.description) items.push({ key: `template:${tpl.uriTemplate}`, text: tpl.description });
    }
    for (const prompt of snapshot.prompts) {
      if (prompt.description) items.push({ key: `prompt:${prompt.name}`, text: prompt.description });
      for (const arg of prompt.arguments ?? []) {
        if (arg.description) items.push({ key: `prompt:${prompt.name}:arg:${arg.name}`, text: arg.description });
      }
    }
    return items;
  }, [snapshot]);

  const pendingTranslationCount = useMemo(
    () =>
      translationItems.filter(
        (item) => item.text && item.text.trim() && !getTranslationDisplay(item.key, item.text).translated
      ).length,
    [translationItems, getTranslationDisplay]
  );

  useEffect(() => {
    if (translationItems.length === 0) return;
    let cancelled = false;
    void seedTranslations(translationItems, () => cancelled).catch(() => {
      /* cache miss is silent */
    });
    return () => {
      cancelled = true;
    };
  }, [lang, translationItems, seedTranslations]);

  const handleTranslateAll = () => {
    if (pendingTranslationCount === 0) {
      toast.success(t('harness.translateAllDone'));
      return Promise.resolve();
    }
    return translateAllDescs(translationItems, (count) =>
      confirmDialog({
        title: t('harness.translateAll'),
        description: `${t('harness.translateAllConfirm')} (${count})`,
      })
    );
  };

  /** Translate all descriptions belonging to the currently selected tool (main + every schema parameter). */
  const selectedToolTranslationItems = useMemo<TranslationItem[]>(() => {
    if (!selectedTool) return [];
    const items: TranslationItem[] = [];
    if (selectedTool.description) items.push({ key: `tool:${selectedTool.name}`, text: selectedTool.description });
    const props = (selectedTool.inputSchema?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [propKey, prop] of Object.entries(props)) {
      if (prop && typeof prop.description === 'string' && prop.description) {
        items.push({ key: `tool:${selectedTool.name}:arg:${propKey}`, text: prop.description });
      }
    }
    return items;
  }, [selectedTool]);

  const selectedToolPendingCount = useMemo(
    () =>
      selectedToolTranslationItems.filter(
        (item) => item.text && item.text.trim() && !getTranslationDisplay(item.key, item.text).translated
      ).length,
    [selectedToolTranslationItems, getTranslationDisplay]
  );

  /** Translate all descriptions belonging to the currently selected prompt (main + every argument). */
  const selectedPromptTranslationItems = useMemo<TranslationItem[]>(() => {
    if (!selectedPrompt) return [];
    const items: TranslationItem[] = [];
    if (selectedPrompt.description) items.push({ key: `prompt:${selectedPrompt.name}`, text: selectedPrompt.description });
    for (const arg of selectedPrompt.arguments ?? []) {
      if (arg.description) items.push({ key: `prompt:${selectedPrompt.name}:arg:${arg.name}`, text: arg.description });
    }
    return items;
  }, [selectedPrompt]);

  const selectedPromptPendingCount = useMemo(
    () =>
      selectedPromptTranslationItems.filter(
        (item) => item.text && item.text.trim() && !getTranslationDisplay(item.key, item.text).translated
      ).length,
    [selectedPromptTranslationItems, getTranslationDisplay]
  );

  const renderSchemaField = (
    key: string,
    prop: Record<string, unknown>,
    isReq: boolean
  ): React.ReactNode => {
    const val = toolFormValues[key];
    const typeLabel = schemaTypeLabel(prop);
    const desc = typeof prop.description === 'string' ? prop.description : '';
    const enumVals = Array.isArray(prop.enum) ? prop.enum : null;

    return (
      <div
        key={key}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid var(--card-border)',
          background: 'var(--bg-elev)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-main)' }}>
            {key}
          </code>
          <span
            style={{
              fontSize: 'var(--text-sm)',
              padding: '1px 6px',
              borderRadius: 4,
              background: 'var(--card-bg)',
              border: '1px solid var(--card-border)',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {typeLabel}
          </span>
          {isReq && (
            <span
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--accent-rose)',
                fontWeight: 600,
              }}
            >
              * {t('mcpBrowser.required')}
            </span>
          )}
        </div>
        {desc && (() => {
          const argKey = `tool:${selectedToolName}:arg:${key}`;
          const argDisplay = getTranslationDisplay(argKey, desc);
          return (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <div style={{ flex: 1, fontSize: 'var(--text-md)', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {argDisplay.text}
              </div>
              {argDisplay.translated && (
                <TranslationBadge
                  showingTranslation={argDisplay.showingTranslation}
                  onToggle={() => toggleOriginal(argKey)}
                />
              )}
            </div>
          );
        })()}
        {enumVals ? (
          <Combobox
            value={val !== undefined ? String(val) : ''}
            onChange={(next) => syncFormValue(key, next === '' ? undefined : next)}
            clearable={!isReq}
            options={enumVals.map((v) => ({ value: String(v), label: String(v) }))}
            placeholder="Select…"
          />
        ) : prop.type === 'boolean' ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--text-md)' }}>
            <input
              type="checkbox"
              checked={Boolean(val)}
              onChange={(e) => syncFormValue(key, e.target.checked)}
            />
            <span>{Boolean(val) ? 'true' : 'false'}</span>
          </label>
        ) : prop.type === 'number' || prop.type === 'integer' ? (
          <input
            className="input"
            type="number"
            value={typeof val === 'number' ? String(val) : ''}
            placeholder={prop.default !== undefined ? String(prop.default) : ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') {
                syncFormValue(key, undefined);
              } else {
                const n = Number(raw);
                if (!Number.isNaN(n)) syncFormValue(key, n);
              }
            }}
          />
        ) : prop.type === 'array' || prop.type === 'object' ? (
          <textarea
            className="input"
            rows={3}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', resize: 'vertical' }}
            value={
              val === undefined
                ? ''
                : typeof val === 'string'
                  ? val
                  : JSON.stringify(val, null, 2)
            }
            placeholder={prop.type === 'array' ? '[]' : '{}'}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw.trim()) {
                syncFormValue(key, undefined);
                return;
              }
              try {
                syncFormValue(key, JSON.parse(raw));
              } catch {
                syncFormValue(key, raw);
              }
            }}
          />
        ) : (
          <input
            className="input"
            type="text"
            value={typeof val === 'string' ? val : val !== undefined ? String(val) : ''}
            placeholder={prop.default !== undefined ? String(prop.default) : ''}
            onChange={(e) => syncFormValue(key, e.target.value === '' && !isReq ? undefined : e.target.value)}
          />
        )}
      </div>
    );
  };

  const renderKeyValEditor = (
    rows: KeyValRow[],
    setRows: React.Dispatch<React.SetStateAction<KeyValRow[]>>,
    label: string,
    keySuggestions?: string[]
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setRows((prev) => [...prev, { key: '', value: '' }])}
        >
          <Plus size={12} /> {t('mcpBrowser.addRow')}
        </button>
      </div>
      {rows.map((row, idx) => (
        <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {keySuggestions && keySuggestions.length > 0 ? (
            <div style={{ flex: 1 }}>
              <SuggestInput
                value={row.key}
                suggestions={keySuggestions}
                placeholder={t('mcpBrowser.keyPlaceholder')}
                style={{ width: '100%' }}
                onChange={(nextKey) =>
                  setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: nextKey } : r)))
                }
              />
            </div>
          ) : (
            <input
              className="input"
              style={{ flex: 1 }}
              placeholder={t('mcpBrowser.keyPlaceholder')}
              value={row.key}
              onChange={(e) =>
                setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
              }
            />
          )}
          <input
            className="input"
            style={{ flex: 1.5 }}
            placeholder={
              row.key.trim().toLowerCase() === 'authorization'
                ? 'Bearer <token>'
                : t('mcpBrowser.valuePlaceholder')
            }
            value={row.value}
            onChange={(e) =>
              setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
            }
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
            aria-label="Remove row"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-2xl)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Compass size={18} />
          {t('mcpBrowser.title')}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
          {t('mcpBrowser.subtitle')}
        </p>
      </div>

      {/* Mode Tabs (left-aligned) + JSON quick-import action (right-aligned in custom mode) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <SegGroup
          value={mode}
          onChange={(v) => {
            setMode(v as TargetMode);
            setConfigCollapsed(false);
          }}
          size="lg"
          options={[
            { value: 'host', label: t('mcpBrowser.modeHost') },
            { value: 'custom', label: t('mcpBrowser.modeCustom') },
          ]}
        />
        {mode === 'custom' && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setImportOpen((o) => !o)}
          >
            <Code2 size={12} /> {t('mcpBrowser.importJson')}
          </button>
        )}
      </div>

      {/* Connection Bar */}
      <div
        style={{
          padding: 12,
          borderRadius: 12,
          border: '1px solid var(--card-border)',
          background: 'var(--card-bg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {!(snapshot && configCollapsed) && (mode === 'host' ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 160, flex: '0 1 200px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.host')}</span>
              <Combobox
                value={selectedHost}
                onChange={setSelectedHost}
                options={hostOptions}
                placeholder={t('mcpBrowser.host')}
              />
            </div>

            <div style={{ minWidth: 120, flex: '0 1 140px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.scope')}</span>
              <Combobox
                value={scope}
                onChange={(v) => setScope(v === 'project' ? 'project' : 'global')}
                options={scopeOptions}
              />
            </div>

            {scope === 'project' && (
              <div style={{ minWidth: 200, flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.project')}</span>
                <ProjectPicker
                  projects={projects}
                  value={selectedProjectId}
                  onChange={setSelectedProjectId}
                  onProjectsChange={handleProjectsChange}
                  placeholder={t('mcpBrowser.project')}
                />
              </div>
            )}

            <div style={{ minWidth: 220, flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.server')}</span>
              <Combobox
                value={selectedServer}
                onChange={setSelectedServer}
                options={serverOptions}
                placeholder={loadingServers ? '…' : hostServers.length === 0 ? t('mcpBrowser.noServersFound') : t('mcpBrowser.selectServerPlaceholder')}
              />
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={connecting || !selectedHost || !selectedServer}
                onClick={() => {
                  const target = buildTarget();
                  if (target) void runInspect(target, Boolean(snapshot));
                }}
              >
                <RefreshCw size={12} className={connecting ? 'spin' : undefined} />
                {connecting ? t('mcpBrowser.connecting') : snapshot ? t('mcpBrowser.reconnect') : t('mcpBrowser.connect')}
              </button>
              {snapshot && (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => void handleDisconnect()}>
                    <Unplug size={12} /> {t('mcpBrowser.disconnect')}
                  </button>
                  {translationItems.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={translationBatch !== null}
                      onClick={() => void handleTranslateAll()}
                      title={t('harness.translateAll')}
                    >
                      <Globe size={12} aria-hidden />
                      <span>
                        {translationBatch
                          ? `${translationBatch.done}/${translationBatch.total}`
                          : pendingTranslationCount > 0
                            ? `${t('harness.translateAll')} (${pendingTranslationCount})`
                            : t('harness.translateAll')}
                      </span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ minWidth: 210, flex: '0 1 240px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.transport')}</span>
                <Combobox
                  value={customTransport}
                  onChange={(v) => setCustomTransport(v as CustomTransport)}
                  options={transportOptions}
                />
              </div>

              {customTransport === 'stdio' ? (
                <>
                  <div style={{ minWidth: 160, flex: '0.8 1 180px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.command')}</span>
                    <input
                      className="input"
                      placeholder={t('mcpBrowser.commandPlaceholder')}
                      value={customCommand}
                      onChange={(e) => setCustomCommand(e.target.value)}
                    />
                  </div>
                  <div style={{ minWidth: 240, flex: '1.5 1 280px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.args')}</span>
                    <input
                      className="input"
                      placeholder={t('mcpBrowser.argsPlaceholder')}
                      value={customArgs}
                      onChange={(e) => setCustomArgs(e.target.value)}
                    />
                  </div>
                  <div style={{ minWidth: 160, flex: '0.8 1 180px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.cwd')}</span>
                    <input
                      className="input"
                      placeholder={t('mcpBrowser.cwdPlaceholder')}
                      value={customCwd}
                      onChange={(e) => setCustomCwd(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div style={{ minWidth: 280, flex: '2 1 360px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.url')}</span>
                  <input
                    className="input"
                    placeholder={t('mcpBrowser.urlPlaceholder')}
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={connecting || (customTransport === 'stdio' ? !customCommand.trim() : !customUrl.trim())}
                  onClick={() => {
                    const target = buildTarget();
                    if (target) void runInspect(target, Boolean(snapshot));
                  }}
                >
                  <RefreshCw size={12} className={connecting ? 'spin' : undefined} />
                  {connecting ? t('mcpBrowser.connecting') : snapshot ? t('mcpBrowser.reconnect') : t('mcpBrowser.connect')}
                </button>
                {snapshot && (
                  <button type="button" className="btn btn-sm" onClick={() => void handleDisconnect()}>
                    <Unplug size={12} /> {t('mcpBrowser.disconnect')}
                  </button>
                )}
              </div>
            </div>

            {customTransport === 'stdio'
              ? renderKeyValEditor(customEnvRows, setCustomEnvRows, t('mcpBrowser.envVars'))
              : renderKeyValEditor(customHeaderRows, setCustomHeaderRows, t('mcpBrowser.headers'), COMMON_HEADER_SUGGESTIONS)}
          </div>
        ))}

        {/* Status Summary */}
        {snapshot && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              paddingTop: configCollapsed ? 0 : 8,
              borderTop: configCollapsed ? 'none' : '1px solid var(--card-border)',
              fontSize: 'var(--text-md)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfigCollapsed((c) => !c)}
                style={{ padding: '2px 6px' }}
                title={configCollapsed ? 'Expand connection settings' : 'Collapse connection settings'}
              >
                {configCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--accent-emerald, #22c55e)', fontWeight: 600 }}>
                <CheckCircle2 size={13} />
                {t('mcpBrowser.connected')}
              </span>
              {snapshot.serverInfo && (
                <span style={{ color: 'var(--text-main)', fontWeight: 500 }}>
                  {snapshot.serverInfo.title || snapshot.serverInfo.name}{' '}
                  <span style={{ color: 'var(--text-muted)' }}>v{snapshot.serverInfo.version}</span>
                </span>
              )}
              <span
                style={{
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--card-border)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {snapshot.transport}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {t('mcpBrowser.tabTools')}: <strong>{snapshot.tools.length}</strong>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {t('mcpBrowser.tabResources')}: <strong>{snapshot.resources.length + snapshot.resourceTemplates.length}</strong>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {t('mcpBrowser.tabPrompts')}: <strong>{snapshot.prompts.length}</strong>
              </span>
              {snapshot.tools.length > 0 && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {t('mcpBrowser.estTokens', { n: totalToolTokens })}
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} />
                  {t('mcpBrowser.durationMs', { ms: snapshot.durationMs })}
                </span>
                {mode === 'custom' && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={customTransport === 'stdio' ? !customCommand.trim() : !customUrl.trim()}
                    onClick={openInstallDialog}
                  >
                    <Download size={12} /> {t('mcpBrowser.installToHost')}
                  </button>
                )}
                {configCollapsed && (
                  <>
                    <button
                      type="button"
                      className={mode === 'custom' ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
                      disabled={connecting}
                      onClick={() => {
                        const target = buildTarget();
                        if (target) void runInspect(target, true);
                      }}
                    >
                      <RefreshCw size={12} className={connecting ? 'spin' : undefined} />
                      {connecting ? t('mcpBrowser.connecting') : t('mcpBrowser.reconnect')}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => void handleDisconnect()}>
                      <Unplug size={12} /> {t('mcpBrowser.disconnect')}
                    </button>
                    {translationItems.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={translationBatch !== null}
                        onClick={() => void handleTranslateAll()}
                        title={t('harness.translateAll')}
                      >
                        <Globe size={12} aria-hidden />
                        <span>
                          {translationBatch
                            ? `${translationBatch.done}/${translationBatch.total}`
                            : pendingTranslationCount > 0
                              ? `${t('harness.translateAll')} (${pendingTranslationCount})`
                              : t('harness.translateAll')}
                        </span>
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ padding: '4px 7px' }}
                  onClick={() => setWorkspaceFullscreen((f) => !f)}
                  title={workspaceFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
                >
                  {workspaceFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
              </div>
            </div>

            {snapshot.instructions && (() => {
              const instrDisplay = getTranslationDisplay('server:instructions', snapshot.instructions);
              return (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ padding: '2px 6px', fontSize: 'var(--text-sm)' }}
                      onClick={() => setInstructionsOpen((o) => !o)}
                    >
                      {instructionsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      {t('mcpBrowser.instructions')}
                    </button>
                    {instructionsOpen && (
                      instrDisplay.translated ? (
                        <TranslationBadge
                          showingTranslation={instrDisplay.showingTranslation}
                          onToggle={() => toggleOriginal('server:instructions')}
                        />
                      ) : (
                        <TranslateButton
                          size={11}
                          compact
                          onClick={() => void translateDesc('server:instructions', snapshot.instructions)}
                        />
                      )
                    )}
                  </div>
                  {instructionsOpen && (
                    <div
                      style={{
                        margin: '6px 0 0',
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'var(--bg-elev)',
                        border: '1px solid var(--card-border)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 'var(--text-md)',
                        lineHeight: 1.55,
                        color: 'var(--text-main)',
                        whiteSpace: 'pre-wrap',
                        maxHeight: 160,
                        overflow: 'auto',
                      }}
                    >
                      {instrDisplay.text}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Main Split Workspace */}
      {!snapshot ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--card-border)',
            borderRadius: 12,
            color: 'var(--text-muted)',
            fontSize: 'var(--text-base)',
            minHeight: 280,
          }}
        >
          {t('mcpBrowser.disconnected')}
        </div>
      ) : (
        <div
          style={
            workspaceFullscreen
              ? {
                position: 'fixed',
                inset: 0,
                zIndex: 900,
                background: 'var(--bg)',
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }
              : {
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }
          }
        >
          {workspaceFullscreen && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                padding: '8px 12px',
                borderRadius: 12,
                border: '1px solid var(--card-border)',
                background: 'var(--card-bg)',
                fontSize: 'var(--text-md)',
                flexShrink: 0,
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--accent-emerald, #22c55e)', fontWeight: 600 }}>
                <CheckCircle2 size={13} />
                {t('mcpBrowser.connected')}
              </span>
              {snapshot.serverInfo && (
                <span style={{ color: 'var(--text-main)', fontWeight: 500 }}>
                  {snapshot.serverInfo.title || snapshot.serverInfo.name}{' '}
                  <span style={{ color: 'var(--text-muted)' }}>v{snapshot.serverInfo.version}</span>
                </span>
              )}
              <span
                style={{
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--card-border)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {snapshot.transport}
              </span>
              <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Clock size={11} />
                  {t('mcpBrowser.durationMs', { ms: snapshot.durationMs })}
                </span>
                {mode === 'custom' && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={customTransport === 'stdio' ? !customCommand.trim() : !customUrl.trim()}
                    onClick={openInstallDialog}
                  >
                    <Download size={12} /> {t('mcpBrowser.installToHost')}
                  </button>
                )}
                <button
                  type="button"
                  className={mode === 'custom' ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
                  disabled={connecting}
                  onClick={() => {
                    const target = buildTarget();
                    if (target) void runInspect(target, true);
                  }}
                >
                  <RefreshCw size={12} className={connecting ? 'spin' : undefined} />
                  {connecting ? t('mcpBrowser.connecting') : t('mcpBrowser.reconnect')}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void handleDisconnect()}>
                  <Unplug size={12} /> {t('mcpBrowser.disconnect')}
                </button>
                {translationItems.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={translationBatch !== null}
                    onClick={() => void handleTranslateAll()}
                    title={t('harness.translateAll')}
                  >
                    <Globe size={12} aria-hidden />
                    <span>
                      {translationBatch
                        ? `${translationBatch.done}/${translationBatch.total}`
                        : pendingTranslationCount > 0
                          ? `${t('harness.translateAll')} (${pendingTranslationCount})`
                          : t('harness.translateAll')}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ padding: '4px 7px' }}
                  onClick={() => setWorkspaceFullscreen(false)}
                  title="Exit fullscreen (Esc)"
                >
                  <Minimize2 size={13} />
                </button>
              </div>
            </div>
          )}

          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'grid',
              gridTemplateColumns: workspaceFullscreen
                ? 'minmax(280px, 360px) minmax(0, 1fr)'
                : 'minmax(260px, 340px) minmax(0, 1fr)',
              gap: 12,
            }}
          >
            {/* Left Panel: Capabilities List */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 12,
                border: '1px solid var(--card-border)',
                background: 'var(--card-bg)',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--card-border)', padding: '4px 6px 0', gap: 2, flexWrap: 'nowrap', overflowX: 'auto' }}>
                {(
                  [
                    { id: 'tools', label: t('mcpBrowser.tabTools'), count: snapshot.tools.length, icon: Wrench },
                    {
                      id: 'resources',
                      label: t('mcpBrowser.tabResources'),
                      count: snapshot.resources.length + snapshot.resourceTemplates.length,
                      icon: FileText,
                    },
                    { id: 'prompts', label: t('mcpBrowser.tabPrompts'), count: snapshot.prompts.length, icon: MessageSquare },
                    { id: 'logs', label: t('mcpBrowser.tabLogs'), count: snapshot.stderr.length, icon: Terminal },
                  ] as const
                ).map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      style={{
                        flex: 1,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        padding: '7px 6px',
                        fontSize: 'var(--text-sm)',
                        fontWeight: active ? 600 : 400,
                        color: active ? 'var(--text-main)' : 'var(--text-muted)',
                        background: active ? 'var(--bg-elev)' : 'transparent',
                        border: 'none',
                        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                        whiteSpace: 'nowrap',
                        cursor: 'pointer',
                      }}
                    >
                      <Icon size={12} />
                      <span>{tab.label}</span>
                      <span style={{ fontSize: 'var(--text-xs)', opacity: 0.75 }}>({tab.count})</span>
                    </button>
                  );
                })}
              </div>

              {/* Search & Translate All */}
              {activeTab !== 'logs' && (
                <div style={{ padding: 8, borderBottom: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <Search
                      size={13}
                      style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }}
                    />
                    <input
                      className="input"
                      style={{ paddingLeft: 28, width: '100%' }}
                      placeholder={t('mcpBrowser.searchPlaceholder')}
                      value={filterText}
                      onChange={(e) => setFilterText(e.target.value)}
                    />
                  </div>
                  {translationItems.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={translationBatch !== null}
                      onClick={() => void handleTranslateAll()}
                      title={t('harness.translateAll')}
                      style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                    >
                      <Globe size={12} aria-hidden />
                      <span>{translationBatch ? `${translationBatch.done}/${translationBatch.total}` : t('harness.translateAll')}</span>
                    </button>
                  )}
                </div>
              )}

              {/* List Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {activeTab === 'tools' &&
                  (filteredTools.length === 0 ? (
                    <div style={{ padding: 16, fontSize: 'var(--text-md)', color: 'var(--text-muted)', textAlign: 'center' }}>
                      {t('mcpBrowser.noTools')}
                    </div>
                  ) : (
                    filteredTools.map((tool) => {
                      const selected = selectedToolName === tool.name;
                      const propCount = Object.keys(
                        (tool.inputSchema?.properties as Record<string, unknown> | undefined) ?? {}
                      ).length;
                      return (
                        <button
                          key={tool.name}
                          type="button"
                          onClick={() => setSelectedToolName(tool.name)}
                          style={{
                            textAlign: 'left',
                            padding: '9px 10px',
                            borderRadius: 8,
                            border: selected ? '1px solid var(--accent)' : '1px solid transparent',
                            background: selected ? 'var(--bg-elev)' : 'transparent',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 5,
                          }}
                        >
                          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-main)', wordBreak: 'break-all' }}>
                            {tool.name}
                          </code>
                          {tool.description && (
                            <div
                              style={{
                                fontSize: 'var(--text-sm)',
                                color: 'var(--text-muted)',
                                lineHeight: 1.45,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                              }}
                            >
                              {getTranslationDisplay(`tool:${tool.name}`, tool.description).text}
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 1 }}>
                            <span
                              style={{
                                fontSize: 'var(--text-xs)',
                                padding: '1px 7px',
                                borderRadius: 999,
                                background: selected ? 'var(--card-bg)' : 'var(--bg-elev)',
                                border: '1px solid var(--card-border)',
                                color: 'var(--text-muted)',
                              }}
                            >
                              {t('mcpBrowser.paramCount', { n: propCount })}
                            </span>
                            <span
                              style={{
                                fontSize: 'var(--text-xs)',
                                padding: '1px 7px',
                                borderRadius: 999,
                                background: selected ? 'var(--card-bg)' : 'var(--bg-elev)',
                                border: '1px solid var(--card-border)',
                                color: 'var(--text-dim)',
                              }}
                            >
                              {t('mcpBrowser.estTokens', { n: estimateTokens(tool) })}
                            </span>
                          </div>
                        </button>
                      );
                    })
                  ))}

                {activeTab === 'resources' &&
                  (filteredResources.length === 0 && filteredTemplates.length === 0 ? (
                    <div style={{ padding: 16, fontSize: 'var(--text-md)', color: 'var(--text-muted)', textAlign: 'center' }}>
                      {t('mcpBrowser.noResources')}
                    </div>
                  ) : (
                    <>
                      {filteredResources.map((res: McpResourceInfo) => {
                        const selected = !selectedIsTemplate && selectedResourceUri === res.uri;
                        return (
                          <button
                            key={res.uri}
                            type="button"
                            onClick={() => {
                              setSelectedIsTemplate(false);
                              setSelectedResourceUri(res.uri);
                              setResourceUriDraft(res.uri);
                              setResourceResult(null);
                            }}
                            style={{
                              textAlign: 'left',
                              padding: '8px 10px',
                              borderRadius: 8,
                              border: selected ? '1px solid var(--accent)' : '1px solid transparent',
                              background: selected ? 'var(--bg-elev)' : 'transparent',
                              cursor: 'pointer',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                            }}
                          >
                            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-main)' }}>
                              {res.title || res.name}
                            </div>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                              {res.uri}
                            </code>
                          </button>
                        );
                      })}

                      {filteredTemplates.length > 0 && (
                        <div style={{ padding: '6px 8px 2px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)', fontWeight: 600 }}>
                          {t('mcpBrowser.resourceTemplates')}
                        </div>
                      )}
                      {filteredTemplates.map((tpl: McpResourceTemplateInfo) => {
                        const selected = selectedIsTemplate && selectedResourceUri === tpl.uriTemplate;
                        return (
                          <button
                            key={tpl.uriTemplate}
                            type="button"
                            onClick={() => {
                              setSelectedIsTemplate(true);
                              setSelectedResourceUri(tpl.uriTemplate);
                              setResourceUriDraft(tpl.uriTemplate);
                              setResourceResult(null);
                            }}
                            style={{
                              textAlign: 'left',
                              padding: '8px 10px',
                              borderRadius: 8,
                              border: selected ? '1px solid var(--accent)' : '1px solid transparent',
                              background: selected ? 'var(--bg-elev)' : 'transparent',
                              cursor: 'pointer',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                            }}
                          >
                            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-main)' }}>
                              {tpl.title || tpl.name}
                            </div>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                              {tpl.uriTemplate}
                            </code>
                          </button>
                        );
                      })}
                    </>
                  ))}

                {activeTab === 'prompts' &&
                  (filteredPrompts.length === 0 ? (
                    <div style={{ padding: 16, fontSize: 'var(--text-md)', color: 'var(--text-muted)', textAlign: 'center' }}>
                      {t('mcpBrowser.noPrompts')}
                    </div>
                  ) : (
                    filteredPrompts.map((p) => {
                      const selected = selectedPromptName === p.name;
                      return (
                        <button
                          key={p.name}
                          type="button"
                          onClick={() => setSelectedPromptName(p.name)}
                          style={{
                            textAlign: 'left',
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: selected ? '1px solid var(--accent)' : '1px solid transparent',
                            background: selected ? 'var(--bg-elev)' : 'transparent',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 3,
                          }}
                        >
                          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-main)' }}>
                            {p.name}
                          </code>
                          {p.description && (
                            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                              {getTranslationDisplay(`prompt:${p.name}`, p.description).text}
                            </div>
                          )}
                        </button>
                      );
                    })
                  ))}

                {activeTab === 'logs' && (
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                      {snapshot.stderr.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void handleCopy(snapshot.stderr.join('\n'))}
                        >
                          <Copy size={11} /> {t('common.copy')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setSnapshot((prev) => (prev ? { ...prev, stderr: [] } : prev))}
                      >
                        {t('mcpBrowser.clearLogs')}
                      </button>
                    </div>
                    {snapshot.stderr.length === 0 ? (
                      <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>
                        {t('mcpBrowser.noLogs')}
                      </div>
                    ) : (
                      <pre
                        style={{
                          margin: 0,
                          flex: 1,
                          fontSize: 'var(--text-sm)',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {snapshot.stderr.join('\n')}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right Panel: Inspector & Runner (split horizontally into Params | Result when result is open) */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                borderRadius: 12,
                border: '1px solid var(--card-border)',
                background: 'var(--card-bg)',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                {activeTab === 'tools' && selectedTool ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-main)' }}>
                          {selectedTool.name}
                        </code>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                            {t('mcpBrowser.schemaChars', { n: JSON.stringify(selectedTool.inputSchema).length })} ·{' '}
                            {t('mcpBrowser.estTokens', { n: estimateTokens(selectedTool) })}
                          </span>
                          {selectedToolTranslationItems.length > 0 && selectedToolPendingCount > 0 && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={translationBatch !== null}
                              onClick={() => void translateAllDescs(selectedToolTranslationItems)}
                              title={t('harness.translate')}
                            >
                              <Globe size={12} aria-hidden />
                              <span>
                                {translationBatch
                                  ? `${translationBatch.done}/${translationBatch.total}`
                                  : t('harness.translate')}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                      {selectedTool.description && (() => {
                        const toolKey = `tool:${selectedTool.name}`;
                        const toolDisplay = getTranslationDisplay(toolKey, selectedTool.description);
                        return (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <p style={{ margin: 0, flex: 1, fontSize: 'var(--text-md)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                              {toolDisplay.text}
                            </p>
                            {toolDisplay.translated ? (
                              <TranslationBadge
                                showingTranslation={toolDisplay.showingTranslation}
                                onToggle={() => toggleOriginal(toolKey)}
                              />
                            ) : (
                              <TranslateButton size={12} compact onClick={() => void translateDesc(toolKey, selectedTool.description)} />
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Input Mode & Action Bar */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <SegGroup
                          value={inputMode}
                          onChange={(v) => switchInputMode(v as InputMode)}
                          size="sm"
                          options={[
                            { value: 'form', label: t('mcpBrowser.inputModeForm') },
                            { value: 'json', label: t('mcpBrowser.inputModeJson') },
                          ]}
                        />
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            const def = schemaDefaults(selectedTool.inputSchema);
                            setToolFormValues(def);
                            setToolJsonText(JSON.stringify(def, null, 2));
                            setToolJsonError(null);
                          }}
                        >
                          {t('mcpBrowser.fillDefaults')}
                        </button>
                        {inputMode === 'json' && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              try {
                                setToolJsonText(JSON.stringify(JSON.parse(toolJsonText || '{}'), null, 2));
                                setToolJsonError(null);
                              } catch {
                                setToolJsonError(t('mcpBrowser.invalidJson'));
                              }
                            }}
                          >
                            {t('mcpBrowser.formatJson')}
                          </button>
                        )}
                      </div>

                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                        <input
                          className="input"
                          type="number"
                          title={t('mcpBrowser.timeoutMs')}
                          aria-label={t('mcpBrowser.timeoutMs')}
                          style={{ width: 76, padding: '4px 6px', fontSize: 'var(--text-sm)', textAlign: 'right' }}
                          value={timeoutMs}
                          min={1000}
                          max={120000}
                          step={1000}
                          onChange={(e) => setTimeoutMs(Number(e.target.value) || 30000)}
                        />
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>ms</span>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={calling}
                          onClick={() => void handleRunTool()}
                        >
                          <Play size={12} /> {calling ? t('mcpBrowser.running') : t('mcpBrowser.runTool')}
                        </button>
                        {toolResult && !resultOpen && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setResultOpen(true)}
                          >
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: toolResult.isError ? 'var(--accent-rose)' : 'var(--accent-emerald, #22c55e)',
                              }}
                            />
                            {t('mcpBrowser.result')} ({t('mcpBrowser.durationMs', { ms: toolResult.durationMs })})
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Form / Raw JSON */}
                    {inputMode === 'form' ? (
                      (() => {
                        const props = (selectedTool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
                        const requiredSet = new Set(
                          Array.isArray(selectedTool.inputSchema?.required)
                            ? (selectedTool.inputSchema.required as string[])
                            : []
                        );
                        const rawKeys = Object.keys(props);
                        const keys = [
                          ...rawKeys.filter((k) => requiredSet.has(k)),
                          ...rawKeys.filter((k) => !requiredSet.has(k)),
                        ];
                        if (keys.length === 0) {
                          return (
                            <div style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', padding: '8px 0' }}>
                              {t('mcpBrowser.noParams')}
                            </div>
                          );
                        }
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {keys.map((k) => renderSchemaField(k, props[k]!, requiredSet.has(k)))}
                          </div>
                        );
                      })()
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <textarea
                          className="input"
                          rows={8}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', resize: 'vertical' }}
                          value={toolJsonText}
                          onChange={(e) => {
                            setToolJsonText(e.target.value);
                            setToolJsonError(null);
                          }}
                        />
                        {toolJsonError && (
                          <span style={{ fontSize: 'var(--text-md)', color: 'var(--accent-rose)' }}>{toolJsonError}</span>
                        )}
                      </div>
                    )}

                    {/* History */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <History size={12} /> {t('mcpBrowser.history')}
                        </span>
                        {toolHistory.length > 0 && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => {
                              if (!serverHistoryKey) return;
                              const next = { ...historyMap };
                              delete next[serverHistoryKey];
                              setHistoryMap(next);
                              writeHistoryMap(next);
                            }}
                          >
                            {t('mcpBrowser.clearHistory')}
                          </button>
                        )}
                      </div>
                      {toolHistory.length === 0 ? (
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>{t('mcpBrowser.noHistory')}</span>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {toolHistory.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className="btn btn-sm"
                              title={JSON.stringify(item.args, null, 2)}
                              onClick={() => {
                                setToolFormValues(item.args);
                                setToolJsonText(JSON.stringify(item.args, null, 2));
                                setToolJsonError(null);
                              }}
                            >
                              {t('mcpBrowser.applyHistory')} · {new Date(item.timestamp).toLocaleTimeString()}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : activeTab === 'resources' && selectedResourceUri ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xl)', fontWeight: 700, wordBreak: 'break-all' }}>
                        {selectedResourceUri}
                      </code>
                      {selectedIsTemplate && (
                        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
                          {t('mcpBrowser.templateUriHint')}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        className="input"
                        style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)' }}
                        value={resourceUriDraft}
                        onChange={(e) => setResourceUriDraft(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={readingResource || !resourceUriDraft.trim()}
                        onClick={() => void handleReadResource()}
                      >
                        <Play size={12} /> {readingResource ? t('mcpBrowser.running') : t('mcpBrowser.readResource')}
                      </button>
                    </div>
                    {resourceResult && (
                      <ResultViewer
                        data={resourceResult.contents}
                        raw={resourceResult}
                        headerLeft={
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                            {t('mcpBrowser.durationMs', { ms: resourceResult.durationMs })}
                          </span>
                        }
                      />
                    )}
                  </>
                ) : activeTab === 'prompts' && selectedPrompt ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xl)', fontWeight: 700 }}>{selectedPrompt.name}</code>
                        {selectedPromptTranslationItems.length > 0 && selectedPromptPendingCount > 0 && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={translationBatch !== null}
                            onClick={() => void translateAllDescs(selectedPromptTranslationItems)}
                            title={t('harness.translate')}
                          >
                            <Globe size={12} aria-hidden />
                            <span>
                              {translationBatch
                                ? `${translationBatch.done}/${translationBatch.total}`
                                : t('harness.translate')}
                            </span>
                          </button>
                        )}
                      </div>
                      {selectedPrompt.description && (() => {
                        const promptKey = `prompt:${selectedPrompt.name}`;
                        const promptDisplay = getTranslationDisplay(promptKey, selectedPrompt.description);
                        return (
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                            <p style={{ margin: 0, flex: 1, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
                              {promptDisplay.text}
                            </p>
                            {promptDisplay.translated ? (
                              <TranslationBadge
                                showingTranslation={promptDisplay.showingTranslation}
                                onToggle={() => toggleOriginal(promptKey)}
                              />
                            ) : (
                              <TranslateButton size={12} compact onClick={() => void translateDesc(promptKey, selectedPrompt.description)} />
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {(selectedPrompt.arguments ?? []).length === 0 ? (
                        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
                          {t('mcpBrowser.noParams')}
                        </span>
                      ) : (
                        [...(selectedPrompt.arguments ?? []).filter((a) => a.required), ...(selectedPrompt.arguments ?? []).filter((a) => !a.required)].map((arg) => {
                          const argKey = `prompt:${selectedPrompt.name}:arg:${arg.name}`;
                          const argDisplay = arg.description ? getTranslationDisplay(argKey, arg.description) : null;
                          return (
                            <div key={arg.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', fontWeight: 600 }}>{arg.name}</code>
                                {arg.required && (
                                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--accent-rose)', fontWeight: 600 }}>
                                    * {t('mcpBrowser.required')}
                                  </span>
                                )}
                              </div>
                              {arg.description && argDisplay && (
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                                  <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{argDisplay.text}</span>
                                  {argDisplay.translated && (
                                    <TranslationBadge
                                      showingTranslation={argDisplay.showingTranslation}
                                      onToggle={() => toggleOriginal(argKey)}
                                    />
                                  )}
                                </div>
                              )}
                              <input
                                className="input"
                                value={promptArgs[arg.name] ?? ''}
                                onChange={(e) => setPromptArgs((prev) => ({ ...prev, [arg.name]: e.target.value }))}
                              />
                            </div>
                          );
                        })
                      )}
                    </div>
                    <div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={gettingPrompt}
                        onClick={() => void handleGetPrompt()}
                      >
                        <Play size={12} /> {gettingPrompt ? t('mcpBrowser.running') : t('mcpBrowser.getPrompt')}
                      </button>
                    </div>
                    {promptResult && (
                      <ResultViewer
                        data={promptResult.messages}
                        raw={promptResult}
                        headerLeft={
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                            {t('mcpBrowser.durationMs', { ms: promptResult.durationMs })}
                          </span>
                        }
                      />
                    )}
                  </>
                ) : (
                  <div style={{ margin: 'auto', fontSize: 'var(--text-md)', color: 'var(--text-muted)', textAlign: 'center' }}>
                    {t('mcpBrowser.selectItemHint')}
                  </div>
                )}
              </div>

              {/* Side-by-Side Tool Result Pane */}
              {activeTab === 'tools' && selectedTool && toolResult && resultOpen && (
                <div
                  style={{
                    width: '44%',
                    minWidth: 280,
                    borderLeft: '1px solid var(--card-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                  }}
                >
                  <ResultViewer
                    fill
                    data={toolResult.structuredContent ?? toolResult.content}
                    raw={toolResult}
                    headerLeft={
                      <>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 'var(--text-sm)',
                            fontWeight: 600,
                            color: toolResult.isError ? 'var(--accent-rose)' : 'var(--accent-emerald, #22c55e)',
                          }}
                        >
                          {toolResult.isError ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
                          {toolResult.isError ? t('mcpBrowser.statusToolError') : t('mcpBrowser.statusOk')}
                        </span>
                        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
                          {t('mcpBrowser.durationMs', { ms: toolResult.durationMs })}
                        </span>
                      </>
                    }
                    headerRight={
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '3px 6px' }}
                        onClick={() => setResultOpen(false)}
                        aria-label={t('mcpBrowser.cancel')}
                      >
                        <X size={12} />
                      </button>
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* JSON Quick-Import Dialog */}
      {importOpen && (
        <Dialog
          title={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Code2 size={16} />
              {t('mcpBrowser.importJson')}
            </span>
          }
          onClose={() => setImportOpen(false)}
          closeLabel={t('mcpBrowser.cancel')}
          width={560}
          footerRight={
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setImportOpen(false);
                  setImportDraft('');
                }}
              >
                {t('mcpBrowser.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!importDraft.trim()}
                onClick={() => {
                  const res = parseMcpSnippet(importDraft);
                  if (!res) {
                    toast.error(t('mcpBrowser.importJsonFailed'));
                    return;
                  }
                  if (snapshot) {
                    void handleDisconnect();
                  }
                  setConfigCollapsed(false);
                  setCustomTransport(res.transport);
                  if (res.transport === 'stdio') {
                    setCustomCommand(res.command ?? '');
                    setCustomArgs(res.args ?? '');
                    setCustomCwd(res.cwd ?? '');
                    setCustomEnvRows(res.envRows ?? []);
                    setCustomUrl('');
                    setCustomHeaderRows([]);
                  } else {
                    setCustomUrl(res.url ?? '');
                    setCustomHeaderRows(res.headerRows ?? []);
                    setCustomCommand('');
                    setCustomArgs('');
                    setCustomCwd('');
                    setCustomEnvRows([]);
                  }
                  setImportOpen(false);
                  setImportDraft('');
                  setCustomNameHint(res.name === 'custom' ? '' : res.name);
                  toast.success(t('mcpBrowser.importJsonSuccess', { name: res.name }));
                }}
              >
                {t('mcpBrowser.importJsonApply')}
              </button>
            </>
          }
        >
          <textarea
            className="input"
            rows={10}
            autoFocus
            style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', resize: 'vertical' }}
            placeholder={t('mcpBrowser.importJsonPlaceholder')}
            value={importDraft}
            onChange={(e) => setImportDraft(e.target.value)}
          />
        </Dialog>
      )}

      {/* Install-to-Host Dialog */}
      {installOpen && (
        <Dialog
          title={t('mcpBrowser.installTitle')}
          onClose={() => setInstallOpen(false)}
          closeLabel={t('mcpBrowser.cancel')}
          closeDisabled={installBusy}
          width={540}
          footerRight={
            <>
              <button type="button" className="btn btn-sm" onClick={() => setInstallOpen(false)}>
                {t('mcpBrowser.cancel')}
              </button>
              {!installPlan ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={installBusy || !installName.trim() || installHosts.length === 0}
                  onClick={() => void submitInstall(false)}
                >
                  {t('mcpBrowser.installPreview')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={installBusy}
                  onClick={() => void submitInstall(true)}
                >
                  <Download size={12} /> {t('mcpBrowser.installConfirm')}
                </button>
              )}
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.installName')}</span>
              <input
                className="input"
                value={installName}
                placeholder={t('mcpBrowser.installNamePlaceholder')}
                onChange={(e) => {
                  setInstallName(e.target.value);
                  setInstallPlan(null);
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: '0 0 140px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.scope')}</span>
                <Combobox
                  value={installScope}
                  onChange={(v) => {
                    setInstallScope(v === 'project' ? 'project' : 'global');
                    setInstallPlan(null);
                  }}
                  options={scopeOptions}
                />
              </div>
              {installScope === 'project' && (
                <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.project')}</span>
                  <ProjectPicker
                    projects={projects}
                    value={installProjectId}
                    onChange={(v) => {
                      setInstallProjectId(v);
                      setInstallPlan(null);
                    }}
                    onProjectsChange={handleProjectsChange}
                    placeholder={t('mcpBrowser.project')}
                  />
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{t('mcpBrowser.installTargets')}</span>
                {hosts.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ padding: '1px 7px', fontSize: 'var(--text-xs)' }}
                    onClick={() => {
                      setInstallPlan(null);
                      setInstallHosts((prev) =>
                        prev.length === hosts.length ? [] : hosts.map((h) => h.id)
                      );
                    }}
                  >
                    {installHosts.length === hosts.length ? t('captures.clearAll') : t('captures.selectAll')}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {hosts.map((h) => {
                  const checked = installHosts.includes(h.id);
                  return (
                    <label
                      key={h.id}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        borderRadius: 8,
                        border: checked ? '1px solid var(--accent)' : '1px solid var(--card-border)',
                        background: checked ? 'var(--bg-elev)' : 'transparent',
                        fontSize: 'var(--text-md)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setInstallPlan(null);
                          setInstallHosts((prev) =>
                            e.target.checked ? [...prev, h.id] : prev.filter((id) => id !== h.id)
                          );
                        }}
                      />
                      <span>{h.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            {installPlan && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: 10,
                  borderRadius: 8,
                  border: '1px solid var(--card-border)',
                  background: 'var(--bg-elev)',
                  fontSize: 'var(--text-md)',
                }}
              >
                <strong>{t('mcpBrowser.installPlanTitle')}</strong>
                {installPlan.map((step, idx) => (
                  <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontWeight: 600 }}>{step.host}</span>
                    {step.file && (
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                        {step.file} ({step.container})
                      </code>
                    )}
                    {step.echo && (
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                        {step.echo}
                      </code>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
};
