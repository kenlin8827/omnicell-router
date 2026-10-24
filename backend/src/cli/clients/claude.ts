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
  OCR_WATERMARK,
} from './base.js';
import { ClientHookStatus } from '../types.js';

export class ClaudeClientAdapter implements ClientAdapter {
  name = 'claude' as const;
  displayName = 'Claude Code / Desktop';

  getConfigPath(): string {
    const home = os.homedir();
    const candidateSettings = path.join(home, '.claude', 'settings.json');
    const candidateClaudeJson = path.join(home, '.claude.json');

    if (fs.existsSync(candidateSettings)) return candidateSettings;
    if (fs.existsSync(candidateClaudeJson)) return candidateClaudeJson;
    return candidateClaudeJson;
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Official Anthropic direct connection';
    const data = exists ? safeReadJson(configPath) : null;

    if (data) {
      const gwPort = defaultGatewayPort();
      if (
        data[OCR_WATERMARK] ||
        data.env?.ANTHROPIC_BASE_URL?.includes(`127.0.0.1:${gwPort}`) ||
        data.anthropicBaseUrl?.includes(`127.0.0.1:${gwPort}`) ||
        data.baseUrl?.includes(`127.0.0.1:${gwPort}`)
      ) {
        hooked = true;
        details = `Routed to OmniCellRouter gateway (:${gwPort})`;
      }
    } else {
      details = 'No Claude configuration file detected';
    }

    const envVal = (key: string): string | undefined =>
      hooked && data?.env?.[key] ? String(data.env[key]) : undefined;

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [
        { key: 'main', value: envVal('ANTHROPIC_MODEL'), default: 'auto' },
        { key: 'haiku', value: envVal('ANTHROPIC_DEFAULT_HAIKU_MODEL'), default: 'lite' },
        { key: 'sonnet', value: envVal('ANTHROPIC_DEFAULT_SONNET_MODEL'), default: 'plus' },
        { key: 'opus', value: envVal('ANTHROPIC_DEFAULT_OPUS_MODEL'), default: 'pro' },
        { key: 'fable', value: envVal('ANTHROPIC_DEFAULT_FABLE_MODEL'), default: 'ultra' },
      ],
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string; contextWindow?: number }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}`;

    let data = safeReadJson(configPath) || {};

    if (fs.existsSync(configPath)) {
      createBackup(configPath);
    }

    if (!data.env || typeof data.env !== 'object') {
      data.env = {};
    }

    // Save previous url if any
    if (data.env.ANTHROPIC_BASE_URL && !data._ocr_previous_base_url) {
      data._ocr_previous_base_url = data.env.ANTHROPIC_BASE_URL;
    }

    // Auth: write a gateway-issued API key, otherwise the client keeps its
    // previous direct-provider token (e.g. Kimi/Anthropic) and gets 401 from
    // the gateway preHandler. Previous value is remembered for teardown restore.
    const apiKey = options?.apiKey?.trim();
    if (apiKey) {
      if (data.env.ANTHROPIC_AUTH_TOKEN && !data._ocr_previous_auth_token) {
        data._ocr_previous_auth_token = data.env.ANTHROPIC_AUTH_TOKEN;
      }
      data.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }

    data.env.ANTHROPIC_BASE_URL = targetUrl;
    data.anthropicBaseUrl = targetUrl;

    // Model slots — Claude Code's real role mapping mechanism:
    // main → ANTHROPIC_MODEL (startup default); opus/sonnet/haiku/fable →
    // ANTHROPIC_DEFAULT_<ROLE>_MODEL (what /model switching sends).
    // The companion *_NAME vars keep the /model menu showing the stock role
    // label ("Opus") instead of the raw pinned model id.
    // Concrete id → pin via env; 'auto' → clear (classifier decides).
    // Slots absent from the record are left untouched (plain `ocr setup` passes none).
    const pinned: string[] = [];
    const slotEnv: Record<string, { model: string; name?: string; label: string }> = {
      main: { model: 'ANTHROPIC_MODEL', label: 'main' },
      opus: { model: 'ANTHROPIC_DEFAULT_OPUS_MODEL', name: 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', label: 'Opus' },
      sonnet: { model: 'ANTHROPIC_DEFAULT_SONNET_MODEL', name: 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', label: 'Sonnet' },
      haiku: { model: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', label: 'Haiku' },
      fable: { model: 'ANTHROPIC_DEFAULT_FABLE_MODEL', name: 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME', label: 'Fable' },
    };
    for (const [slot, { model, name, label }] of Object.entries(slotEnv)) {
      const v = options?.models?.[slot]?.trim();
      if (v === undefined) continue;
      if (v && v !== 'auto') {
        data.env[model] = v;
        if (name) data.env[name] = label;
        pinned.push(`${slot}=${v}`);
      } else {
        if (data.env[model]) delete data.env[model];
        if (name && data.env[name]) delete data.env[name];
      }
    }

    data[OCR_WATERMARK] = true;

    // Context window hint: the hooked client can't know the real context of
    // dynamically routed models (it would assume Anthropic's native 200K).
    // Write the user-selected window so compaction math matches the fleet.
    const contextWindow = options?.contextWindow;
    if (contextWindow && contextWindow > 0) {
      const cw = String(Math.floor(contextWindow));
      data.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = cw;
      data.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = cw;
    }

    safeWriteJson(configPath, data);

    return {
      success: true,
      message: `Claude configured to route via OCR (${targetUrl}${apiKey ? ', auth token updated' : ''}${contextWindow && contextWindow > 0 ? `, ctx=${contextWindow}` : ''}${pinned.length ? `, ${pinned.join(', ')}` : ', slots untouched'}). Backup saved to ${configPath}.bak.ocr`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    if (restoreBackup(configPath)) {
      return {
        success: true,
        message: `Claude configuration restored from backup (${configPath}.bak.ocr)`,
      };
    }

    const data = safeReadJson(configPath);
    if (!data) {
      return { success: false, message: `Could not parse Claude config at ${configPath}` };
    }

    if (data._ocr_previous_base_url) {
      if (data.env) data.env.ANTHROPIC_BASE_URL = data._ocr_previous_base_url;
      data.anthropicBaseUrl = data._ocr_previous_base_url;
      delete data._ocr_previous_base_url;
    } else {
      if (data.env?.ANTHROPIC_BASE_URL) delete data.env.ANTHROPIC_BASE_URL;
      if (data.anthropicBaseUrl) delete data.anthropicBaseUrl;
    }

    if (data._ocr_previous_auth_token) {
      if (data.env) data.env.ANTHROPIC_AUTH_TOKEN = data._ocr_previous_auth_token;
      delete data._ocr_previous_auth_token;
    }

    if (data[OCR_WATERMARK]) {
      delete data[OCR_WATERMARK];
    }
    // Surgical path (backup missing): clear the slot envs we may have written.
    // The primary teardown path is backup restore above, which brings back the
    // user's original file verbatim (including their own model envs).
    for (const envKey of [
      'ANTHROPIC_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    ]) {
      if (data.env?.[envKey]) delete data.env[envKey];
    }

    safeWriteJson(configPath, data);

    return {
      success: true,
      message: 'Claude configuration decoupled from OCR. Direct Anthropic routing restored.',
    };
  }
}
