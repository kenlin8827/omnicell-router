import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import TOML from '@iarna/toml';
import {
  ClientAdapter,
  createBackup,
  restoreBackup,
  defaultGatewayPort,
  OCR_WATERMARK,
} from './base.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';

/**
 * Hook target: Grok CLI (xAI). Grok reads `~/.grok/config.toml`; custom
 * endpoints are `[model.<name>]` tables pointing at a `model_provider` (a
 * `[model_providers.<id>]` block) or a direct `base_url`. We register ONE
 * managed provider (`ocr`) on the gateway's OpenAI Chat Completions endpoint
 * and one catalog entry per exposed model (`ocr` = main slot, `ocr-<id>` for
 * extras), each carrying the gateway-issued key, then pin `[models].default`
 * to the main entry. Unlike the JSON-config clients, TOML has no sanctioned
 * comment-preserving rewrite, so setup does a full parse/stringify round-trip
 * — the pre-write backup (`createBackup`) is the user-content safety net.
 */
export class GrokClientAdapter implements ClientAdapter {
  name = 'grok' as const;
  displayName = 'Grok CLI';

  /** Provider table id this adapter owns inside `[model_providers]`. */
  private static readonly PROVIDER_ID = 'ocr';
  /** Catalog key of the main-slot entry inside `[model]`. */
  private static readonly MAIN_KEY = 'ocr';
  /** Prefix for extra-model catalog keys (`ocr-<gateway model id>`). */
  private static readonly EXTRA_PREFIX = `${GrokClientAdapter.MAIN_KEY}-`;

  getConfigPath(): string {
    return path.join(os.homedir(), '.grok', 'config.toml');
  }

  async getStatus(): Promise<ClientHookStatus> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Direct xAI API connection';
    let mainValue: string | undefined;
    let extras: string[] | undefined;
    let data: TOML.JsonMap | null = null;

    if (exists) {
      data = this.readToml(configPath);
      if (data) {
        const gwPort = defaultGatewayPort();
        // TOML tables index to the lib's AnyJson union; this adapter owns the
        // managed shapes, so the reads converge through explicit casts. The
        // base_url read stays typeof-guarded: a hand-edited scalar would make
        // .includes throw, and getAllClientStatuses fans getStatus through a
        // bare Promise.all — one bad config would 500 the whole endpoint.
        const provider = (data.model_providers as TOML.JsonMap | undefined)?.[
          GrokClientAdapter.PROVIDER_ID
        ] as { base_url?: unknown } | undefined;
        const providerRouted =
          typeof provider?.base_url === 'string' && provider.base_url.includes(`127.0.0.1:${gwPort}`);
        if (data[OCR_WATERMARK] || providerRouted) {
          hooked = true;
          details = `Routed to OmniCellRouter gateway (:${gwPort}/v1, chat_completions)`;
          const models = data.model as TOML.JsonMap | undefined;
          const main = models?.[GrokClientAdapter.MAIN_KEY] as { model?: string } | undefined;
          mainValue = main?.model ? String(main.model) : undefined;
          extras = Object.keys(models || {})
            .filter(
              k =>
                k.startsWith(GrokClientAdapter.EXTRA_PREFIX) &&
                ((models as TOML.JsonMap)[k] as { model_provider?: unknown } | undefined)?.model_provider ===
                  GrokClientAdapter.PROVIDER_ID &&
                !VIRTUAL_AUTO_IDS.has(k.slice(GrokClientAdapter.EXTRA_PREFIX.length))
            )
            .map(k => k.slice(GrokClientAdapter.EXTRA_PREFIX.length));
        }
      } else {
        details = 'Config exists but could not be parsed as TOML — fix it manually, then re-apply';
      }
    } else {
      details = 'No Grok config file detected';
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [{ key: 'main', value: mainValue, default: 'auto' }],
      extraModels: extras,
    };
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    apiKey?: string;
    contextWindow?: number;
    extraModels?: string[];
    /** Follow mode: the virtual tier subset the selected key's policy admits. */
    virtualModels?: string[];
  }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const apiKey = options?.apiKey?.trim();
    if (!apiKey) {
      return { success: false, message: 'Grok takeover requires a gateway API key (the [model.*] entries carry it)' };
    }

    // Never overwrite a config we cannot parse — it may hold hand-edited TOML.
    let data: TOML.JsonMap = {};
    if (fs.existsSync(configPath)) {
      const parsed = this.readToml(configPath);
      if (parsed === null) {
        return { success: false, message: `Could not parse TOML at ${configPath}; refusing to overwrite` };
      }
      data = parsed;
      createBackup(configPath);
    }

    const main = options?.models?.main?.trim() || 'auto';
    // Virtual tier entries never ride in extras (the echo strips them); a
    // follow-mode setup passes them separately (`virtualModels` — the subset
    // the selected key's policy admits) and they land as `ocr-<id>` entries.
    const extras = (options?.extraModels || [])
      .map(id => (id || '').trim())
      .filter(id => id && id !== main && !VIRTUAL_AUTO_IDS.has(id));
    const virtuals = Array.isArray(options?.virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter(id => options.virtualModels!.includes(id) && id !== main)
      : [];
    const contextWindow =
      options?.contextWindow && options.contextWindow > 0 ? Math.floor(options.contextWindow) : undefined;
    // Hand-edited TOML may carry a scalar or array where a table belongs;
    // property writes on primitives throw in ESM strict mode, so normalize
    // to a table — the original value is replaced when the table re-assigns.
    const asTable = (v: unknown): TOML.JsonMap =>
      v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as TOML.JsonMap) : {};

    const providers = asTable(data.model_providers);
    providers[GrokClientAdapter.PROVIDER_ID] = {
      base_url: targetUrl,
      api_backend: 'chat_completions',
    };
    data.model_providers = providers;

    const models = asTable(data.model);
    const entry = (modelId: string): TOML.JsonMap => {
      const e: TOML.JsonMap = {
        model: modelId,
        model_provider: GrokClientAdapter.PROVIDER_ID,
        api_key: apiKey,
        // The picker displays `name` verbatim — label entries with the
        // gateway model id they carry, never a fixed brand string.
        name: modelId,
      };
      if (contextWindow) e.context_window = contextWindow;
      return e;
    };
    for (const key of this.managedKeys(models)) delete models[key];
    models[GrokClientAdapter.MAIN_KEY] = entry(main);
    for (const id of virtuals) models[`${GrokClientAdapter.EXTRA_PREFIX}${id}`] = entry(id);
    for (const id of extras) models[`${GrokClientAdapter.EXTRA_PREFIX}${id}`] = entry(id);
    data.model = models;

    // Take over the default-model pin; the previous value is restored on teardown.
    const modelsDefaults = asTable(data.models);
    if (typeof modelsDefaults.default === 'string' && modelsDefaults.default && !data._ocr_previous_default) {
      data._ocr_previous_default = modelsDefaults.default;
    }
    modelsDefaults.default = GrokClientAdapter.MAIN_KEY;
    data.models = modelsDefaults;
    data[OCR_WATERMARK] = true;

    this.writeToml(configPath, data);

    const backupNote = fs.existsSync(`${configPath}.bak.ocr`)
      ? ` Backup saved to ${configPath}.bak.ocr`
      : '';
    return {
      success: true,
      message: `Grok configured to route via OCR (${targetUrl}, ${1 + virtuals.length + extras.length} model entr${virtuals.length + extras.length === 0 ? 'y' : 'ies'}, default: ${GrokClientAdapter.MAIN_KEY}).${backupNote}`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();

    if (!fs.existsSync(configPath)) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    const restored = restoreBackup(configPath);
    const data = this.readToml(configPath);
    if (data === null) {
      return { success: false, message: `Could not parse Grok config at ${configPath}` };
    }

    // Restore-then-strip: a backup taken during a REPEAT setup snapshots the
    // already-hooked config, so restore alone would leave the hook in place
    // (the pi adapter fixed this same class of bug). The managed keys are
    // stripped from whatever restore produced — or from the live config when
    // no backup exists — and that result is what gets written back.
    this.strip(data);
    this.writeToml(configPath, data);

    return {
      success: true,
      message: restored
        ? `Grok configuration restored from backup (${configPath}.bak.ocr)`
        : 'Grok configuration decoupled from OCR. Reverted to standard configuration.',
    };
  }

  /** Remove every OCR-owned key from a parsed config (teardown core). */
  private strip(data: TOML.JsonMap): void {
    const models = data.model as TOML.JsonMap | undefined;
    if (models) {
      for (const key of this.managedKeys(models)) delete models[key];
      if (Object.keys(models).length === 0) delete data.model;
    }
    const providers = data.model_providers as TOML.JsonMap | undefined;
    if (providers?.[GrokClientAdapter.PROVIDER_ID]) {
      delete providers[GrokClientAdapter.PROVIDER_ID];
      if (Object.keys(providers).length === 0) delete data.model_providers;
    }
    const modelsDefaults = data.models as TOML.JsonMap | undefined;
    if (modelsDefaults) {
      const previous = data._ocr_previous_default;
      if (typeof previous === 'string' && previous) {
        modelsDefaults.default = previous;
      } else if (modelsDefaults.default === GrokClientAdapter.MAIN_KEY) {
        delete modelsDefaults.default;
      }
      if (Object.keys(modelsDefaults).length === 0) delete data.models;
    }
    // Unconditional: the marker must not survive even if the user hand-deleted
    // the [models] table between setup and teardown.
    delete data._ocr_previous_default;
    delete data[OCR_WATERMARK];
  }

  /**
   * Catalog keys currently owned by this adapter: the reserved main key plus
   * `ocr-*` extras carrying OUR provider marker. Entries merely NAMED
   * `ocr-*` are the user's own — a prefix-only sweep deleted them twice
   * (at setup, then again in teardown's restore-then-strip).
   */
  private managedKeys(model: TOML.JsonMap | undefined): string[] {
    return Object.keys(model || {}).filter(k => {
      if (k === GrokClientAdapter.MAIN_KEY) return true;
      if (!k.startsWith(GrokClientAdapter.EXTRA_PREFIX)) return false;
      const entry = (model as TOML.JsonMap)[k] as TOML.JsonMap | undefined;
      return entry?.model_provider === GrokClientAdapter.PROVIDER_ID;
    });
  }

  private readToml(configPath: string): TOML.JsonMap | null {
    try {
      return TOML.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return null;
    }
  }

  private writeToml(configPath: string, data: TOML.JsonMap): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Atomic tmp+rename, same contract as safeWriteJson — a crash mid-write
    // must never corrupt the user's config (first setup has no backup yet).
    const tmp = `${configPath}.tmp.ocr`;
    fs.writeFileSync(tmp, TOML.stringify(data));
    renameWithRetry(tmp, configPath);
  }
}
