import fs from 'node:fs';
import path from 'node:path';
import { ClientHookStatus, ModelProfileBinding, SupportedClient } from '../types.js';
import { loadConfig } from '../../config/index.js';
import { renameWithRetry } from '../../utils/atomic-write.js';

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
  getConfigPath(): string;
  /** Async by contract: adapters may probe external processes (e.g. `opencode service get env`); never block the event loop. */
  getStatus(): Promise<ClientHookStatus>;
  /**
   * Model slots: slotKey → model id | 'auto' (intelligent routing default).
   * Only slots present in the record are written; absent slots stay untouched
   * (the plain `ocr setup` CLI command passes no models). apiKey (optional):
   * gateway-issued key to write into the client's auth field.
   */
  setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; /** Context window tokens written to the client's context-management envs (claude: MAX_CONTEXT_TOKENS + AUTO_COMPACT_WINDOW) */ contextWindow?: number; /** Extra concrete models to expose in the client's model switcher (models list for adapters that honor it: opencode/dsh/pi) */ extraModels?: string[]; /** Virtual tier entries to inject (follow mode): the subset of auto/lite/plus/pro/ultra the selected key's policy admits. Absent = the adapter's default block (all five where it injects any). */ virtualModels?: string[]; /** Effective agent bindings (opencode): agent name → resolved modelRef ('auto' = inherit the default model). */ agentModels?: Record<string, string>; /** Profile-link echo written to the OCR sidecar meta when defined: agent → profile-slot key; id '' un-links. */ profile?: ModelProfileBinding }): Promise<ClientActionResult>;
  /**
   * Profile-change write-through (opencode, pi): re-resolve the linked
   * agents' slot keys against the just-saved profile slots and rewrite the
   * client config without a full setup. Absent on adapters without profile
   * links.
   */
  refreshProfileBindings?(profileId: string, tags: Record<string, string>, slots: Record<string, string>): Promise<ClientActionResult>;
  teardown(): Promise<ClientActionResult>;
}
