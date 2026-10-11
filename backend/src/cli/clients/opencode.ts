import fs from 'node:fs';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  safeReadJson,
  defaultGatewayPort,
} from './base.js';
import { ClientHookStatus } from '../types.js';
import {
  ROUTER_PROVIDER_ID,
  getOpenCodeConfigPath,
  patchJsonc,
  readJsonc,
} from '../../opencode/user-config.js';

/**
 * OpenCode client adapter.
 *
 * OpenCode v2 config schema notes:
 *  - Custom/static providers live under the *singular* `provider` node
 *    (NOT `providers`), each entry being an AI SDK provider package binding:
 *      "provider": { "<id>": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": ... }, "models": {...} } }
 *  - The file is JSONC (comments allowed) — every write must be a
 *    comment-preserving text-level edit (see opencode/user-config.ts).
 *  - The default model is selected via the top-level `model` key ("provider/model-id").
 */

/** Sidecar that remembers the user's previous default model across setup/teardown. */
function metaPathFor(configPath: string): string {
  return `${configPath}.ocr-meta.json`;
}

function readMeta(configPath: string): { previousModel?: string } {
  try {
    const p = metaPathFor(configPath);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // ignore
  }
  return {};
}

function writeMeta(configPath: string, meta: { previousModel?: string }): void {
  try {
    fs.writeFileSync(metaPathFor(configPath), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // best effort
  }
}

function buildRouterProviderNode(port: number, model?: string, extraModels?: string[], apiKey?: string): any {
  const targetUrl = `http://127.0.0.1:${port}/v1`;
  const modelEntry = (label: string) => ({ name: label });
  const models: Record<string, { name: string }> = {
    auto: modelEntry('Auto (intelligent multi-tier routing)'),
    'auto-lite': modelEntry('Force Lite tier'),
    'auto-plus': modelEntry('Force Plus tier'),
    'auto-pro': modelEntry('Force Pro tier'),
    'auto-ultra': modelEntry('Force Ultra tier'),
  };
  // Pin a concrete registered model: expose it in the client's model picker.
  if (model && model !== 'auto' && !model.startsWith('auto-')) {
    models[model] = modelEntry(`Pinned: ${model}`);
  }
  // Additional concrete models so the user can switch freely inside OpenCode.
  for (const m of extraModels || []) {
    const id = (m || '').trim();
    if (id && !models[id]) models[id] = modelEntry(id);
  }
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'OpenCode Router',
    options: {
      baseURL: targetUrl,
      // Gateway-issued key when the user picks one; legacy fallback keeps the
      // historical placeholder (works only if config.apiKeys contains it).
      apiKey: apiKey || 'ocr-local-token',
    },
    models,
  };
}

export class OpenCodeClientAdapter implements ClientAdapter {
  name = 'opencode' as const;
  displayName = 'OpenCode';

  getConfigPath(): string {
    return getOpenCodeConfigPath();
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Not configured';

    if (exists) {
      // Tolerant JSONC read (comments-safe); fall back to legacy plain-JSON reader.
      const data = readJsonc(configPath) ?? safeReadJson(configPath);
      if (data) {
        const routerEntry = data.provider?.[ROUTER_PROVIDER_ID];
        if (routerEntry?.options?.baseURL) {
          hooked = true;
          details = `Routed to OpenCode Router gateway (${routerEntry.options.baseURL})`;
        } else if (data.providers?.ocr || data.providers?.['opencode-router']) {
          // Legacy (invalid-schema) leftovers from previous adapter versions
          hooked = true;
          details = 'Legacy hook detected (invalid schema) — re-run setup to fix';
        } else {
          details = 'Active with native providers';
        }
      } else {
        details = 'Config file present (unparsed/empty)';
      }
    } else {
      details = 'No OpenCode configuration detected';
    }

    // Current slot values: strip the `opencode-router/` namespace prefix
    const hookedData = hooked ? ((readJsonc(configPath) as any) || {}) : null;
    const stripPrefix = (v: any): string | undefined =>
      typeof v === 'string' && v.startsWith(`${ROUTER_PROVIDER_ID}/`)
        ? v.slice(ROUTER_PROVIDER_ID.length + 1)
        : undefined;

    // Extra concrete models exposed in the provider's switcher (non-virtual entries)
    const mainId = stripPrefix(hookedData?.model);
    const AUTO_MODEL_KEYS = new Set(['auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra']);
    const providerModels = hookedData?.provider?.[ROUTER_PROVIDER_ID]?.models;
    const extraModels =
      providerModels && typeof providerModels === 'object'
        ? Object.keys(providerModels).filter(k => !AUTO_MODEL_KEYS.has(k) && k !== mainId)
        : undefined;

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [
        { key: 'main', value: mainId, default: 'auto' },
        { key: 'subagent', value: stripPrefix(hookedData?.agent?.general?.model), default: 'auto-lite' },
      ],
      extraModels,
    };
  }

  async setup(options?: { port?: number; models?: Record<string, string>; extraModels?: string[]; apiKey?: string }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    const main = options?.models?.main?.trim() || 'auto';
    const extraModels = (options?.extraModels || []).map(s => (s || '').trim()).filter(Boolean);
    const apiKey = options?.apiKey?.trim() || undefined;

    // 1. Safety backup (single rolling .bak.ocr, restorable via teardown)
    if (fs.existsSync(configPath)) {
      createBackup(configPath);
    }

    // 2. Inject the router provider under the correct singular `provider` node
    //    using a comment-preserving JSONC edit.
    patchJsonc(configPath, ['provider', ROUTER_PROVIDER_ID], buildRouterProviderNode(port, main, extraModels, apiKey));

    // 3. Point the default model at the router (record previous for teardown)
    const current = readJsonc(configPath) || {};
    const previousModel = current?.model;
    const targetModel = `${ROUTER_PROVIDER_ID}/${main}`;
    if (previousModel && previousModel !== targetModel) {
      writeMeta(configPath, { previousModel });
    }
    patchJsonc(configPath, ['model'], targetModel);

    // 4. Subagent slot (OpenCode's default subagent is "general"); 'auto' removes the override
    const subagent = options?.models?.subagent?.trim();
    if (subagent !== undefined) {
      const agentModel = (readJsonc(configPath) as any)?.agent?.general?.model;
      if (subagent && subagent !== 'auto') {
        patchJsonc(configPath, ['agent', 'general', 'model'], `${ROUTER_PROVIDER_ID}/${subagent}`);
      } else if (agentModel) {
        patchJsonc(configPath, ['agent', 'general', 'model'], undefined);
      }
    }

    return {
      success: true,
      message: `OpenCode routed to OCR gateway (http://127.0.0.1:${port}/v1, main: ${targetModel}${subagent && subagent !== 'auto' ? `, subagent: ${subagent}` : ''}). Backup at ${configPath}.bak.ocr`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    // If backup exists, restore it directly (full revert, comments included)
    if (restoreBackup(configPath)) {
      return {
        success: true,
        message: `OpenCode configuration restored from backup (${configPath}.bak.ocr)`,
      };
    }

    // Otherwise surgically remove our provider node + default-model override
    const data = readJsonc(configPath);
    if (!data) {
      return { success: false, message: `Could not parse OpenCode config at ${configPath}` };
    }

    if (data.provider?.[ROUTER_PROVIDER_ID]) {
      patchJsonc(configPath, ['provider', ROUTER_PROVIDER_ID], undefined);
    }

    if (data.model === `${ROUTER_PROVIDER_ID}/auto`) {
      const { previousModel } = readMeta(configPath);
      if (previousModel) {
        patchJsonc(configPath, ['model'], previousModel);
      } else {
        patchJsonc(configPath, ['model'], undefined);
      }
    }

    // Remove subagent model override if it points at the router
    const subagentModel = (data as any)?.agent?.general?.model;
    if (typeof subagentModel === 'string' && subagentModel.startsWith(`${ROUTER_PROVIDER_ID}/`)) {
      patchJsonc(configPath, ['agent', 'general', 'model'], undefined);
    }

    // Clean legacy invalid-schema leftovers (providers.ocr etc.)
    const legacy = safeReadJson(configPath);
    if (legacy?.providers?.ocr || legacy?.[ 'opencode-router-managed' ]) {
      const cleaned = { ...legacy };
      delete cleaned.providers?.ocr;
      delete cleaned[ 'opencode-router-managed' ];
      if (cleaned._ocr_previous_default !== undefined) {
        if (cleaned._ocr_previous_default) cleaned.defaultProvider = cleaned._ocr_previous_default;
        delete cleaned._ocr_previous_default;
      }
      if (cleaned.defaultProvider === 'ocr') delete cleaned.defaultProvider;
      fs.writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
    }

    return {
      success: true,
      message: 'OpenCode configuration reverted successfully. OCR gateway decoupled.',
    };
  }
}
