import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ClientHookStatus, ModelProfileBinding, SupportedClient } from '../types.js';
import { loadConfig, getRuntimeConfigRef } from '../../config/index.js';
import { DEFAULT_FORWARD_PROXY_PORT } from '../../config/defaults.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import { getOcrHomeDir } from '../paths.js';
import type { RouterConfig } from '../../config/types.js';
export const OCR_DEFAULT_PORT = 4000;
export const OCR_DEFAULT_URL = `http://127.0.0.1:${OCR_DEFAULT_PORT}`;
export const OCR_DEFAULT_V1_URL = `${OCR_DEFAULT_URL}/v1`;
export const OCR_WATERMARK = 'omnicell-router-managed';

/**
 * Port the gateway actually listens on — config.yaml `port` is the single
 * source of truth (backend/src/index.ts listens on loadConfig().port). Client
 * hooks and daemon tooling MUST derive base URLs from here so what they write
 * always matches the running gateway. OCR_DEFAULT_PORT stays only as a
 * last-resort fallback for when config is unreadable (bare CLI outside a repo).
 */
export function defaultGatewayPort(): number {
  try {
    const port = loadConfig().port;
    return Number.isFinite(port) && port > 0 ? port : OCR_DEFAULT_PORT;
  } catch {
    return OCR_DEFAULT_PORT;
  }
}

/** Strip json comments (line and block) without external dependency */
export function stripJsonComments(jsonStr: string): string {
  return jsonStr
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
}

export function safeReadJson(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const cleaned = stripJsonComments(raw);
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export function safeWriteJson(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  try {
    renameWithRetry(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

export function createBackup(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak.ocr`;
  try {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

export function restoreBackup(filePath: string): boolean {
  const backupPath = `${filePath}.bak.ocr`;
  if (!fs.existsSync(backupPath)) return false;
  try {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    return true;
  } catch {
    return false;
  }
}

export interface ClientActionResult {
  success: boolean;
  /** Human-readable detail (English, backend-side); the console prefers the reasonCode template when one is mapped. */
  message: string;
  /** Machine-readable failure reason for console i18n mapping (absent = no dedicated key — the raw message shows). */
  reasonCode?: string;
  /** Template params for the reasonCode's i18n string. */
  params?: Record<string, string>;
}

export interface ClientAdapter {
  name: SupportedClient;
  displayName: string;
  /**
   * Oldest CLI release whose config contract this adapter's writes still
   * honor — the compatibility floor, NOT the newest verified version. Set
   * together with `versionCmd`; absent = no version gate for this client.
   */
  minVersion?: string;
  /** Command whose output reports the installed CLI version (e.g. `['kimi', '--version']`). */
  versionCmd?: string[];
  getConfigPath(): string;
  /** Async by contract: adapters may probe external processes (e.g. `opencode service get env`); never block the event loop. */
  getStatus(): Promise<ClientHookStatus>;
  /**
   * Model slots: slotKey → model id | 'auto' (intelligent routing default).
   * Only slots present in the record are written; absent slots stay untouched
   * (the plain `ocr setup` CLI command passes no models). apiKey (optional):
   * gateway-issued key to write into the client's auth field.
   */
  setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; /** Context window tokens written to the client's context-management envs (claude: CLAUDE_CODE_MAX_CONTEXT_TOKENS + CLAUDE_CODE_AUTO_COMPACT_WINDOW) */ contextWindow?: number; /** Extra concrete models to expose in the client's model switcher (adapters that publish a model list) */ extraModels?: string[]; /** Virtual tier entries to inject (follow mode): the subset of auto/lite/plus/pro/ultra the selected key's policy admits. Absent = the adapter's default block (all five where it injects any). */ virtualModels?: string[]; /** Effective agent bindings: agent/role name → resolved modelRef ('auto' = inherit the default model), written by the adapters that carry agent bindings. */ agentModels?: Record<string, string>; /** Profile-link echo written to the OCR sidecar meta when defined: agent → profile-slot key; id '' un-links. */ profile?: ModelProfileBinding }): Promise<ClientActionResult>;
  /**
   * Profile-change write-through: re-resolve the linked agents' slot keys
   * against the just-saved profile slots and rewrite the client config
   * without a full setup. Absent on adapters without profile links.
   */
  refreshProfileBindings?(profileId: string, tags: Record<string, string>, slots: Record<string, string>): Promise<ClientActionResult>;
  teardown(): Promise<ClientActionResult>;
}

/** Version-probe cache: one entry per command, 10-minute TTL — status polls
 *  must not spawn a subprocess every refresh, and CLI versions don't churn. */
const versionProbeCache = new Map<string, { version: string | null; at: number }>();
const VERSION_PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * Probe the installed CLI version by running the adapter's version command.
 * Returns the first `major[.minor[.patch…]]` token in the output (CLI banners
 * are prose — "kimi version 2.4.1"), or null when the command fails/times out
 * (absent client, non-zero exit). Failures are cached like successes so a
 */
export async function probeClientVersion(cmd: string[]): Promise<string | null> {
  const key = cmd.join(' ');
  const hit = versionProbeCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_PROBE_TTL_MS) return hit.version;
  const { ok, stdout } = await runCommand(cmd[0], cmd.slice(1), 5000);
  const version = ok ? stdout.match(/\d+(?:\.\d+)+/)?.[0] ?? null : null;
  versionProbeCache.set(key, { version, at: Date.now() });
  return version;
}

/** Client-facing forward-proxy endpoint derived from the runtime config snapshot. */
export interface ForwardProxyEndpoint {
  url: string;
  port: number;
  caPath: string;
}

/**
 * Effective forward-proxy endpoint from the runtime config snapshot; null
 * when the forward proxy is disabled or the config is unreadable.
 */
export function resolveForwardProxyEndpoint(): ForwardProxyEndpoint | null {
  let cfg: RouterConfig | undefined;
  try {
    cfg = getRuntimeConfigRef() || loadConfig();
  } catch {
    return null;
  }
  const fp = cfg?.forwardProxy;
  if (!fp || fp.enabled !== true) return null;
  const port = Number.isFinite(fp.port) && (fp.port as number) > 0 ? (fp.port as number) : DEFAULT_FORWARD_PROXY_PORT;
  // `host` is a LISTEN address — the client-facing URL must stay reachable
  // from the client on the same machine, so wildcard binds normalize to loopback.
  const host = !fp.host || fp.host === '0.0.0.0' || fp.host === '::' ? '127.0.0.1' : fp.host;
  const caDir = fp.caDir?.trim() || path.join(getOcrHomeDir(), 'forward-proxy');
  return { url: `http://${host}:${port}`, port, caPath: path.join(caDir, 'ca.pem') };
}

/** Result of a one-shot command run: exit status plus captured output. */
export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Asynchronous one-shot command runner with a timeout; never throws.
 *
 * Windows: CLI commands may be npm `.cmd` shims, so the spawn goes through
 * cmd.exe and args containing spaces/cmd metacharacters are pre-quoted for
 * the shell line (note: `%` inside double quotes is still cmd-expanded —
 * paths containing `%` are out of scope). Other platforms spawn directly
 * with an argv array.
 */
export async function runCommand(cmd: string, args: string[], timeoutMs = 5000): Promise<CommandResult> {
  const isWin = process.platform === 'win32';
  const finalArgs = isWin
    ? args.map(a => (/[\s"%^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    : args;
  let resolve: (r: CommandResult) => void = () => {};
  const promise = new Promise<CommandResult>(r => {
    resolve = r;
  });
  let stdout = '';
  let stderr = '';
  try {
    const proc = spawn(cmd, finalArgs, { timeout: timeoutMs, windowsHide: true, shell: isWin });
    proc.stdout?.on('data', (c: Buffer) => (stdout += String(c)));
    proc.stderr?.on('data', (c: Buffer) => (stderr += String(c)));
    proc.on('error', err => resolve({ ok: false, stdout, stderr: String(err) }));
    proc.on('close', code => resolve({ ok: code === 0, stdout, stderr }));
  } catch (err) {
    resolve({ ok: false, stdout, stderr: String(err) });
  }
  return promise;

}
