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

export class CodexClientAdapter implements ClientAdapter {
  name = 'codex' as const;
  displayName = 'Codex / OpenAI CLI';

  getConfigPath(): string {
    const home = os.homedir();
    const candidateCodex = path.join(home, '.codex', 'config.json');
    const candidateOpenAi = path.join(home, '.openai', 'config.json');

    if (fs.existsSync(candidateCodex)) return candidateCodex;
    if (fs.existsSync(candidateOpenAi)) return candidateOpenAi;
    return candidateCodex;
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Direct OpenAI API connection';
    const data = exists ? safeReadJson(configPath) : null;

    if (data) {
      const gwPort = defaultGatewayPort();
      if (
        data[OCR_WATERMARK] ||
        data.baseUrl?.includes(`127.0.0.1:${gwPort}`) ||
        data.api_base?.includes(`127.0.0.1:${gwPort}`)
      ) {
        hooked = true;
        details = `Routed to OpenCode Router gateway (:${gwPort}/v1)`;
      }
    } else {
      details = 'No Codex/OpenAI config file detected';
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [{ key: 'main', value: hooked && data?.model ? String(data.model) : undefined, default: 'auto' }],
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; apiKey?: string }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;

    let data = safeReadJson(configPath) || {};

    if (fs.existsSync(configPath)) {
      createBackup(configPath);
    }

    if (data.baseUrl && !data._ocr_previous_base_url) {
      data._ocr_previous_base_url = data.baseUrl;
    }

    data.baseUrl = targetUrl;
    data.api_base = targetUrl;
    const main = options?.models?.main?.trim();
    data.model = main || data.model || 'auto';
    // Auth for the gateway preHandler (schema field unverified against the
    // real Codex CLI — the adapter's config.json is already non-standard).
    const apiKey = options?.apiKey?.trim();
    if (apiKey) data.apiKey = apiKey;
    data[OCR_WATERMARK] = true;

    safeWriteJson(configPath, data);

    return {
      success: true,
      message: `Codex configured to route via OCR (${targetUrl}, model: ${data.model}). Backup saved to ${configPath}.bak.ocr`,
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
        message: `Codex configuration restored from backup (${configPath}.bak.ocr)`,
      };
    }

    const data = safeReadJson(configPath);
    if (!data) {
      return { success: false, message: `Could not parse Codex config at ${configPath}` };
    }

    if (data._ocr_previous_base_url) {
      data.baseUrl = data._ocr_previous_base_url;
      data.api_base = data._ocr_previous_base_url;
      delete data._ocr_previous_base_url;
    } else {
      delete data.baseUrl;
      delete data.api_base;
    }

    if (data[OCR_WATERMARK]) {
      delete data[OCR_WATERMARK];
    }

    safeWriteJson(configPath, data);

    return {
      success: true,
      message: `Codex configuration decoupled from OCR. Reverted to standard configuration.`,
    };
  }
}
