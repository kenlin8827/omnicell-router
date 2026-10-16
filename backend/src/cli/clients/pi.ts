import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  safeReadJson,
  safeWriteJson,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';

/**
 * Provider key written into pi's `~/.pi/agent/models.json` — the key name
 * itself is the hook marker. pi validates models.json against a strict schema
 * (unknown top-level keys fail the whole file), so the OCR_WATERMARK trick
 * used by claude/codex is not safe here. Detection is host-agnostic: a valid
 * http(s) baseUrl on this key means the client routes through an OCR gateway
 * (local loopback, LAN-bound host, or a remote box — all are "hooked").
 */
const PI_PROVIDER_KEY = 'opencode-router';

/** Placeholder apiKey — pi's schema REQUIRES apiKey whenever custom models are declared. */
const PI_FALLBACK_API_KEY = '***';

/** baseUrl of the OCR provider entry, when it is a usable http(s) URL. */
const hookBaseUrl = (entry: any): string | undefined =>
  typeof entry?.baseUrl === 'string' && /^https?:\/\//.test(entry.baseUrl) ? entry.baseUrl : undefined;

export class PiClientAdapter implements ClientAdapter {
  name = 'pi' as const;
  displayName = 'Pi Coding Agent';

  getConfigPath(): string {
    return path.join(os.homedir(), '.pi', 'agent', 'models.json');
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    const data = exists ? safeReadJson(configPath) : null;
    const entry = data?.providers?.[PI_PROVIDER_KEY];
    const url = hookBaseUrl(entry);

    // Port match is only a details-text nicety (drift after a gateway port
    // change → re-apply hint); the hooked state itself is key + URL presence.
    let portFresh = false;
    if (url) {
      try {
        portFresh = new URL(url).port === String(defaultGatewayPort());
      } catch {
        /* malformed URL — leave stale */
      }
    }

    let details = 'Direct provider connection (built-in pi catalog)';
    if (url) {
      details = portFresh
        ? `Routed to OpenCode Router gateway (${url})`
        : `Routed via OCR gateway URL ${url} — current port is :${defaultGatewayPort()}, re-apply setup to refresh`;
    } else if (!exists) {
      details = 'No pi config file detected (~/.pi/agent/models.json)';
    }

    const models: any[] = url && Array.isArray(entry.models) ? entry.models : [];
    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked: !!url,
      backupExists,
      details,
      // Pi has one model picker (/model, --model); the first entry is the main slot.
      modelSlots: [{ key: 'main', value: models[0]?.id ? String(models[0].id) : undefined, default: 'auto' }],
      // The fixed auto* alias block (see setup) is router-owned, not a user choice —
      // never echo it back as extra entries.
      extraModels: models.slice(1).map((m: any) => String(m.id)).filter(id => id && !VIRTUAL_AUTO_IDS.has(id)),
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; contextWindow?: number; extraModels?: string[] }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    // Never overwrite a models.json we cannot read — it likely holds the
    // user's own providers (Ollama, vLLM, …) that a blind write would erase.
    let data: any = {};
    if (fs.existsSync(configPath)) {
      const parsed = safeReadJson(configPath);
      if (parsed === null) {
        return { success: false, message: `Could not parse pi config at ${configPath} — fix it manually or remove it, then retry.` };
      }
      data = parsed;
      createBackup(configPath);
    }

    if (!data.providers || typeof data.providers !== 'object') data.providers = {};

    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const main = options?.models?.main?.trim() || 'auto';
    // Fixed auto* tier aliases are always exposed (the gateway resolves them
    // natively), then the user's extra concrete models. Main stays slot #1;
    // everything is deduped against what is already listed.
    const extras = (options?.extraModels || []).map(id => id.trim()).filter(id => id && id !== main);
    const ids = [main, ...[...VIRTUAL_AUTO_IDS].filter(id => id !== main && !extras.includes(id)), ...extras];
    const contextWindow = options?.contextWindow && options.contextWindow > 0 ? Math.floor(options.contextWindow) : undefined;
    // Gateway-issued key wins; keep the previous entry's key; placeholder only
    // as last resort (pi needs the field present; the gateway preHandler may
    // still 401 without a real key when adminApiKey auth is enabled).
    const apiKey = options?.apiKey?.trim() || data.providers[PI_PROVIDER_KEY]?.apiKey || PI_FALLBACK_API_KEY;

    data.providers[PI_PROVIDER_KEY] = {
      baseUrl: targetUrl,
      api: 'openai-completions',
      apiKey,
      models: ids.map(id => (contextWindow ? { id, contextWindow } : { id })),
    };

    safeWriteJson(configPath, data);

    return {
      success: true,
      message: `Pi configured to route via OCR (${targetUrl}, model: ${main}${ids.length > 1 ? ` +${ids.length - 1} extra` : ''}${contextWindow ? `, ctx=${contextWindow}` : ''}, key: ${apiKey === PI_FALLBACK_API_KEY ? 'placeholder' : 'set'}). Backup saved to ${configPath}.bak.ocr`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    // Restore-then-strip: a backup from a re-setup (port change, console
    // reset-models) contains the hooked file — restoring it alone would leave
    // the client routed while teardown claims success. Stripping the provider
    // key after any restore makes backup contamination harmless by design.
    if (restoreBackup(configPath)) {
      const restored = safeReadJson(configPath);
      if (restored?.providers?.[PI_PROVIDER_KEY]) {
        delete restored.providers[PI_PROVIDER_KEY];
        safeWriteJson(configPath, restored);
      }
      return {
        success: true,
        message: `Pi configuration restored from backup (${configPath}.bak.ocr)`,
      };
    }

    const data = safeReadJson(configPath);
    if (!data) {
      return { success: false, message: `Could not parse pi config at ${configPath}` };
    }

    if (data.providers?.[PI_PROVIDER_KEY]) {
      delete data.providers[PI_PROVIDER_KEY];
      safeWriteJson(configPath, data);
      return { success: true, message: `Pi decoupled from OCR: provider '${PI_PROVIDER_KEY}' removed. Other providers untouched.` };
    }

    return { success: true, message: `No OCR hook present in ${configPath}; left untouched.` };
  }
}
