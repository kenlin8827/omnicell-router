import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { readMcpRawEntry } from './mcp-edit.js';
import type { HarnessHostId, HarnessScope } from '../types.js';

/**
 * Live MCP server inspector & debugger (Harness enhancement).
 *
 * Connects to either a host-configured MCP server (resolving its raw launch & secret references
 * strictly on the server side without ever leaking secret values to the console) or an ad-hoc
 * custom target (stdio / streamable-http / sse), caches active client sessions briefly for
 * interactive tool/resource/prompt debugging, and cleans up idle child processes automatically.
 */

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_DEFAULT_MS = 30_000;
const CALL_TIMEOUT_MAX_MS = 120_000;
const SESSION_IDLE_TTL_MS = 5 * 60_000;
const MAX_STDERR_LINES = 200;

export type McpInspectTarget =
  | {
      mode: 'host';
      host: HarnessHostId;
      scope: HarnessScope;
      name: string;
      projectRoot?: string;
    }
  | {
      mode: 'custom';
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      mode: 'custom';
      transport: 'auto' | 'streamable-http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    };

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateInfo {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpInspectSnapshot {
  sessionId: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  serverInfo: {
    name: string;
    version: string;
    title?: string;
  } | null;
  instructions?: string;
  capabilities: Record<string, unknown>;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
  prompts: McpPromptInfo[];
  stderr: string[];
  connectedAt: number;
  durationMs: number;
}

export interface McpCallToolResponse {
  sessionId: string;
  toolName: string;
  isError: boolean;
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  durationMs: number;
  stderr: string[];
}

export interface McpReadResourceResponse {
  sessionId: string;
  uri: string;
  contents: unknown[];
  durationMs: number;
  stderr: string[];
}

export interface McpGetPromptResponse {
  sessionId: string;
  promptName: string;
  description?: string;
  messages: unknown[];
  durationMs: number;
  stderr: string[];
}

type ResolvedConnection =
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: 'auto' | 'streamable-http' | 'sse';
      url: string;
      headers: Record<string, string>;
    };

interface ManagedSession {
  sessionId: string;
  targetKey: string;
  transportKind: 'stdio' | 'streamable-http' | 'sse';
  client: Client;
  transport: Transport;
  stderr: string[];
  connectedAt: number;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

const sessionsById = new Map<string, ManagedSession>();
const sessionIdByKey = new Map<string, string>();

const OPENCODE_ENV_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SHELL_ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expand `{env:KEY}` and `${KEY}` references against process.env on the server side. */
function expandSecretRefs(value: string): string {
  return value
    .replace(OPENCODE_ENV_RE, (_m, key: string) => process.env[key] ?? '')
    .replace(SHELL_ENV_RE, (_m, key: string) => process.env[key] ?? '');
}

function resolveStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = expandSecretRefs(v);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    }
  }
  return out;
}

function targetCacheKey(target: McpInspectTarget): string {
  if (target.mode === 'host') {
    return `host:${target.host}:${target.scope}:${target.projectRoot ?? ''}:${target.name}`;
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex').slice(0, 16);
  return `custom:${digest}`;
}

function resolveConnection(target: McpInspectTarget): { ok: true; conn: ResolvedConnection } | { ok: false; code: 'bad_request' | 'not_found'; message: string } {
  if (target.mode === 'custom') {
    if (target.transport === 'stdio') {
      const cmd = target.command?.trim();
      if (!cmd) return { ok: false, code: 'bad_request', message: 'command is required for stdio transport' };
      return {
        ok: true,
        conn: {
          transport: 'stdio',
          command: cmd,
          args: Array.isArray(target.args) ? target.args.map(String) : [],
          env: resolveStringMap(target.env),
          ...(target.cwd?.trim() ? { cwd: target.cwd.trim() } : {}),
        },
      };
    }
    const rawUrl = target.url?.trim();
    if (!rawUrl) return { ok: false, code: 'bad_request', message: 'url is required for remote transport' };
    try {
      new URL(rawUrl);
    } catch {
      return { ok: false, code: 'bad_request', message: `invalid url '${rawUrl}'` };
    }
    return {
      ok: true,
      conn: {
        transport: target.transport,
        url: rawUrl,
        headers: resolveStringMap(target.headers),
      },
    };
  }

  const rawRes = readMcpRawEntry({
    host: target.host,
    scope: target.scope,
    name: target.name,
    ...(target.projectRoot ? { projectRoot: target.projectRoot } : {}),
  });
  if (!rawRes.ok) return rawRes;
  const raw = rawRes.raw;

  if (Array.isArray(raw.command)) {
    const parts = raw.command.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length === 0) return { ok: false, code: 'bad_request', message: 'entry command array is empty' };
    const [command, ...args] = parts;
    return {
      ok: true,
      conn: {
        transport: 'stdio',
        command: command!,
        args,
        env: resolveStringMap(raw.environment ?? raw.env),
        ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
      },
    };
  }

  if (typeof raw.command === 'string' && raw.command.trim() !== '') {
    const args = Array.isArray(raw.args) ? raw.args.filter((p): p is string => typeof p === 'string') : [];
    return {
      ok: true,
      conn: {
        transport: 'stdio',
        command: raw.command.trim(),
        args,
        env: resolveStringMap(raw.environment ?? raw.env),
        ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
      },
    };
  }

  if (typeof raw.url === 'string' && raw.url.trim() !== '') {
    const rawUrl = raw.url.trim();
    try {
      new URL(rawUrl);
    } catch {
      return { ok: false, code: 'bad_request', message: `entry url '${rawUrl}' is invalid` };
    }
    const rawType = typeof raw.type === 'string' ? raw.type.toLowerCase() : typeof raw.transport === 'string' ? raw.transport.toLowerCase() : 'auto';
    const transport: 'auto' | 'streamable-http' | 'sse' =
      rawType === 'sse' ? 'sse' : rawType === 'streamable-http' || rawType === 'http' ? 'streamable-http' : 'auto';
    const headers = {
      ...resolveStringMap(raw.http_headers),
      ...resolveStringMap(raw.headers),
    };
    if (typeof raw.bearer_token_env_var === 'string' && raw.bearer_token_env_var.trim()) {
      const token = process.env[raw.bearer_token_env_var.trim()];
      if (token && !headers.Authorization && !headers.authorization) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    return {
      ok: true,
      conn: {
        transport,
        url: rawUrl,
        headers,
      },
    };
  }

  return { ok: false, code: 'bad_request', message: 'entry carries neither a command nor a url' };
}

function appendStderr(bucket: string[], chunk: string): void {
  const lines = chunk.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (!line) continue;
    bucket.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    if (bucket.length > MAX_STDERR_LINES) {
      bucket.splice(0, bucket.length - MAX_STDERR_LINES);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function touchSession(session: ManagedSession): void {
  session.lastUsedAt = Date.now();
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void closeSession(session);
  }, SESSION_IDLE_TTL_MS);
  session.idleTimer.unref?.();
}

async function closeSession(session: ManagedSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  sessionsById.delete(session.sessionId);
  if (sessionIdByKey.get(session.targetKey) === session.sessionId) {
    sessionIdByKey.delete(session.targetKey);
  }
  try {
    await session.client.close();
  } catch {
    // Ignore close errors during teardown.
  }
  try {
    await session.transport.close();
  } catch {
    // Ignore close errors during teardown.
  }
}

function makeHeaderFetch(headers: Record<string, string>): typeof fetch | undefined {
  if (Object.keys(headers).length === 0) return undefined;
  return (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headers)) {
      if (!merged.has(k)) merged.set(k, v);
    }
    return fetch(input, { ...init, headers: merged });
  };
}

async function openSession(target: McpInspectTarget): Promise<ManagedSession> {
  const resolved = resolveConnection(target);
  if (!resolved.ok) {
    const err = new Error(resolved.message) as Error & { code?: string };
    err.code = resolved.code;
    throw err;
  }

  const key = targetCacheKey(target);
  const stderr: string[] = [];

  const connectWith = async (
    kind: 'stdio' | 'streamable-http' | 'sse',
    transport: Transport
  ): Promise<ManagedSession> => {
    const client = new Client({ name: 'omnicell-router-inspector', version: '1.0.0' }, { capabilities: {} });
    const sessionId = crypto.randomUUID();
    const session: ManagedSession = {
      sessionId,
      targetKey: key,
      transportKind: kind,
      client,
      transport,
      stderr,
      connectedAt: Date.now(),
      lastUsedAt: Date.now(),
      idleTimer: null,
      closed: false,
    };

    transport.onclose = () => {
      void closeSession(session);
    };
    transport.onerror = (err) => {
      appendStderr(stderr, `[transport error] ${err.message}`);
    };

    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'MCP connect');
    } catch (err) {
      try {
        await client.close();
      } catch {
        // Ignore cleanup failure.
      }
      try {
        await transport.close();
      } catch {
        // Ignore cleanup failure.
      }
      if (stderr.length > 0) {
        const tail = stderr.slice(-8).join('\n');
        const msg = err instanceof Error ? err.message : String(err);
        const enriched = new Error(`${msg}\n--- stderr ---\n${tail}`) as Error & { code?: string };
        enriched.code = (err as { code?: string })?.code;
        throw enriched;
      }
      throw err;
    }

    sessionsById.set(sessionId, session);
    sessionIdByKey.set(key, sessionId);
    touchSession(session);
    return session;
  };

  const conn = resolved.conn;
  if (conn.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: conn.command,
      args: conn.args,
      env: { ...getDefaultEnvironment(), ...conn.env },
      stderr: 'pipe',
      ...(conn.cwd ? { cwd: conn.cwd } : {}),
    });
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on('data', (chunk: Buffer | string) => {
        appendStderr(stderr, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
    }
    return await connectWith('stdio', transport);
  }

  const customFetch = makeHeaderFetch(conn.headers);
  const url = new URL(conn.url);

  if (conn.transport === 'streamable-http') {
    const transport = new StreamableHTTPClientTransport(url, {
      ...(Object.keys(conn.headers).length > 0 ? { requestInit: { headers: conn.headers } } : {}),
      ...(customFetch ? { fetch: customFetch } : {}),
    });
    return await connectWith('streamable-http', transport);
  }

  if (conn.transport === 'sse') {
    const transport = new SSEClientTransport(url, {
      ...(Object.keys(conn.headers).length > 0 ? { requestInit: { headers: conn.headers } } : {}),
      ...(customFetch ? { fetch: customFetch } : {}),
    });
    return await connectWith('sse', transport);
  }

  // Auto mode: try Streamable HTTP first, then fall back to legacy SSE.
  try {
    const streamable = new StreamableHTTPClientTransport(url, {
      ...(Object.keys(conn.headers).length > 0 ? { requestInit: { headers: conn.headers } } : {}),
      ...(customFetch ? { fetch: customFetch } : {}),
    });
    return await connectWith('streamable-http', streamable);
  } catch (httpErr) {
    appendStderr(
      stderr,
      `[auto-fallback] Streamable HTTP failed (${httpErr instanceof Error ? httpErr.message : String(httpErr)}), trying SSE…`
    );
    const sse = new SSEClientTransport(url, {
      ...(Object.keys(conn.headers).length > 0 ? { requestInit: { headers: conn.headers } } : {}),
      ...(customFetch ? { fetch: customFetch } : {}),
    });
    return await connectWith('sse', sse);
  }
}

async function getOrOpenSession(opts: {
  sessionId?: string;
  target?: McpInspectTarget;
  refresh?: boolean;
}): Promise<ManagedSession> {
  if (opts.refresh && opts.sessionId) {
    const old = sessionsById.get(opts.sessionId);
    if (old) await closeSession(old);
  }
  if (!opts.refresh && opts.sessionId) {
    const existing = sessionsById.get(opts.sessionId);
    if (existing && !existing.closed) {
      touchSession(existing);
      return existing;
    }
  }
  if (!opts.target) {
    const err = new Error('MCP session expired or not found — reconnect first') as Error & { code?: string };
    err.code = 'not_found';
    throw err;
  }

  const key = targetCacheKey(opts.target);
  const cachedId = sessionIdByKey.get(key);
  if (cachedId) {
    const existing = sessionsById.get(cachedId);
    if (existing && !existing.closed && !opts.refresh) {
      touchSession(existing);
      return existing;
    }
    if (existing) await closeSession(existing);
  }

  return await openSession(opts.target);
}

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  const items: McpToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await withTimeout(client.listTools(cursor ? { cursor } : undefined), CALL_TIMEOUT_DEFAULT_MS, 'listTools');
    for (const tool of res.tools) {
      items.push({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
        ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
      });
    }
    cursor = res.nextCursor;
  } while (cursor);
  return items;
}

async function listAllResources(client: Client): Promise<McpResourceInfo[]> {
  const items: McpResourceInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await withTimeout(client.listResources(cursor ? { cursor } : undefined), CALL_TIMEOUT_DEFAULT_MS, 'listResources');
    for (const r of res.resources) {
      items.push({
        uri: r.uri,
        name: r.name,
        ...(r.title ? { title: r.title } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      });
    }
    cursor = res.nextCursor;
  } while (cursor);
  return items;
}

async function listAllResourceTemplates(client: Client): Promise<McpResourceTemplateInfo[]> {
  const items: McpResourceTemplateInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await withTimeout(
      client.listResourceTemplates(cursor ? { cursor } : undefined),
      CALL_TIMEOUT_DEFAULT_MS,
      'listResourceTemplates'
    );
    for (const r of res.resourceTemplates) {
      items.push({
        uriTemplate: r.uriTemplate,
        name: r.name,
        ...(r.title ? { title: r.title } : {}),
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      });
    }
    cursor = res.nextCursor;
  } while (cursor);
  return items;
}

async function listAllPrompts(client: Client): Promise<McpPromptInfo[]> {
  const items: McpPromptInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await withTimeout(client.listPrompts(cursor ? { cursor } : undefined), CALL_TIMEOUT_DEFAULT_MS, 'listPrompts');
    for (const p of res.prompts) {
      items.push({
        name: p.name,
        ...(p.title ? { title: p.title } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.arguments ? { arguments: p.arguments } : {}),
      });
    }
    cursor = res.nextCursor;
  } while (cursor);
  return items;
}

/** Connect to an MCP server and enumerate its declared capabilities, tools, resources, and prompts. */
export async function inspectMcpServer(
  target: McpInspectTarget,
  opts?: { refresh?: boolean }
): Promise<McpInspectSnapshot> {
  const started = Date.now();
  const session = await getOrOpenSession({ target, refresh: opts?.refresh });
  const capabilities = (session.client.getServerCapabilities() ?? {}) as Record<string, unknown>;
  const version = session.client.getServerVersion();
  const instructions = session.client.getInstructions();

  const [tools, resources, resourceTemplates, prompts] = await Promise.all([
    capabilities.tools ? listAllTools(session.client).catch(() => [] as McpToolInfo[]) : Promise.resolve([]),
    capabilities.resources ? listAllResources(session.client).catch(() => [] as McpResourceInfo[]) : Promise.resolve([]),
    capabilities.resources
      ? listAllResourceTemplates(session.client).catch(() => [] as McpResourceTemplateInfo[])
      : Promise.resolve([]),
    capabilities.prompts ? listAllPrompts(session.client).catch(() => [] as McpPromptInfo[]) : Promise.resolve([]),
  ]);

  touchSession(session);
  return {
    sessionId: session.sessionId,
    transport: session.transportKind,
    serverInfo: version
      ? {
          name: version.name,
          version: version.version,
          ...(version.title ? { title: version.title } : {}),
        }
      : null,
    ...(instructions ? { instructions } : {}),
    capabilities,
    tools,
    resources,
    resourceTemplates,
    prompts,
    stderr: [...session.stderr],
    connectedAt: session.connectedAt,
    durationMs: Date.now() - started,
  };
}

function clampTimeout(ms?: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return CALL_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(1_000, Math.floor(ms)), CALL_TIMEOUT_MAX_MS);
}

/** Invoke one MCP tool on an active (or auto-reconnected) session. */
export async function callMcpTool(input: {
  sessionId?: string;
  target?: McpInspectTarget;
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<McpCallToolResponse> {
  const session = await getOrOpenSession({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.target ? { target: input.target } : {}),
  });
  const timeoutMs = clampTimeout(input.timeoutMs);
  const started = Date.now();
  const res = await withTimeout(
    session.client.callTool({
      name: input.toolName,
      arguments: input.arguments ?? {},
    }),
    timeoutMs,
    `callTool(${input.toolName})`
  );
  touchSession(session);
  const record = res as Record<string, unknown>;
  return {
    sessionId: session.sessionId,
    toolName: input.toolName,
    isError: Boolean(record.isError),
    content: Array.isArray(record.content) ? record.content : [],
    ...(record.structuredContent && typeof record.structuredContent === 'object'
      ? { structuredContent: record.structuredContent as Record<string, unknown> }
      : {}),
    durationMs: Date.now() - started,
    stderr: [...session.stderr],
  };
}

/** Read one MCP resource URI on an active (or auto-reconnected) session. */
export async function readMcpResource(input: {
  sessionId?: string;
  target?: McpInspectTarget;
  uri: string;
  timeoutMs?: number;
}): Promise<McpReadResourceResponse> {
  const session = await getOrOpenSession({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.target ? { target: input.target } : {}),
  });
  const timeoutMs = clampTimeout(input.timeoutMs);
  const started = Date.now();
  const res = await withTimeout(
    session.client.readResource({ uri: input.uri }),
    timeoutMs,
    `readResource(${input.uri})`
  );
  touchSession(session);
  return {
    sessionId: session.sessionId,
    uri: input.uri,
    contents: Array.isArray(res.contents) ? res.contents : [],
    durationMs: Date.now() - started,
    stderr: [...session.stderr],
  };
}

/** Get one MCP prompt with optional arguments on an active (or auto-reconnected) session. */
export async function getMcpPrompt(input: {
  sessionId?: string;
  target?: McpInspectTarget;
  promptName: string;
  arguments?: Record<string, string>;
  timeoutMs?: number;
}): Promise<McpGetPromptResponse> {
  const session = await getOrOpenSession({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.target ? { target: input.target } : {}),
  });
  const timeoutMs = clampTimeout(input.timeoutMs);
  const started = Date.now();
  const res = await withTimeout(
    session.client.getPrompt({
      name: input.promptName,
      ...(input.arguments && Object.keys(input.arguments).length > 0 ? { arguments: input.arguments } : {}),
    }),
    timeoutMs,
    `getPrompt(${input.promptName})`
  );
  touchSession(session);
  return {
    sessionId: session.sessionId,
    promptName: input.promptName,
    ...(res.description ? { description: res.description } : {}),
    messages: Array.isArray(res.messages) ? res.messages : [],
    durationMs: Date.now() - started,
    stderr: [...session.stderr],
  };
}

/** Explicitly close one inspector session and release any child process. */
export async function disconnectMcpSession(sessionId: string): Promise<boolean> {
  const session = sessionsById.get(sessionId);
  if (!session) return false;
  await closeSession(session);
  return true;
}

/** Close all cached inspector sessions (called on server shutdown). */
export async function closeAllMcpInspectSessions(): Promise<void> {
  const all = [...sessionsById.values()];
  await Promise.all(all.map((s) => closeSession(s)));
}
