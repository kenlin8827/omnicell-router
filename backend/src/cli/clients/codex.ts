import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import TOML from '@iarna/toml';
import {
  ClientAdapter,
  createBackup,
  describeBackup,
  restoreBackup,
  defaultGatewayPort,
} from './base.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';

/** One Codex-native catalog row (stock OpenAI entry or synthetic OCR id). */
export type CodexStockModel = Record<string, unknown> & { slug: string };

/** Injectable stock-catalog loader — CI must not require a live `codex` binary. */
export type CodexStockCatalogLoader = () => CodexStockModel[];

/**
 * Default loader: `codex debug models` in a throwaway CODEX_HOME with only
 * the built-in openai provider. Failures surface as an empty list so setup
 * still writes the OCR block (stock is best-effort).
 */
export function loadCodexStockCatalog(): CodexStockModel[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-codex-stock-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'config.toml'),
      ['model = "gpt-5.4"', 'model_provider = "openai"', ''].join('\n'),
    );
    const res = spawnSync('codex', ['debug', 'models'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: tmp },
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) return [];
    const parsed = JSON.parse(res.stdout) as { models?: CodexStockModel[] };
    return Array.isArray(parsed.models)
      ? parsed.models.filter((m) => typeof m?.slug === 'string' && m.slug)
      : [];
  } catch {
    return [];
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Hook target: OpenAI Codex CLI and ChatGPT Desktop — both read
 * `~/.codex/config.toml`. One write shape for both:
 *
 * - keep built-in `model_provider = "openai"`
 * - point `openai_base_url` at the gateway
 * - pin `model_catalog_json` = OCR selection first, then remaining stock
 *   OpenAI entries (Desktop’s allowlist still shows stock slugs; CLI `/model`
 *   shows the full merged list)
 * - gateway key in `auth.json` (`OPENAI_API_KEY`)
 *
 * Legacy `omnicell-router` provider marks are stripped on setup/teardown so a
 * previous CLI-only hook does not linger. TOML has no comment-preserving
 * rewrite; the pre-write backup is the safety net.
 */
export class CodexClientAdapter implements ClientAdapter {
  name = 'codex' as const;
  hookKind = 'config' as const;
  /** One hook covers Codex CLI and ChatGPT Desktop (shared ~/.codex). */
  displayName = 'Codex / ChatGPT';
  shortName = 'Codex / ChatGPT';

  /** Retired custom-provider id — still stripped for upgrade cleanliness. */
  private static readonly LEGACY_PROVIDER_ID = 'omnicell-router';
  private static readonly PROFILE_PREFIX = 'ocr-';
  private static readonly CATALOG_FILE = 'omnicell-router-models.json';
  /** Previous Desktop-only catalog name — cleared on setup/teardown. */
  private static readonly LEGACY_DESKTOP_CATALOG = 'chatgpt-ocr-models.json';
  private static readonly AUTH_MODE_API = 'apikey';
  private static readonly CATALOG_INSTRUCTIONS =
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. You help the user with software engineering tasks.';

  /** Override in tests to supply a fixture stock catalog. */
  stockCatalogLoader: CodexStockCatalogLoader = loadCodexStockCatalog;

  getConfigPath(): string {
    return path.join(os.homedir(), '.codex', 'config.toml');
  }

  private authPath(): string {
    return path.join(path.dirname(this.getConfigPath()), 'auth.json');
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const configPath = this.getConfigPath();
    const configDir = path.dirname(configPath);
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Direct OpenAI / ChatGPT connection';
    let mainValue: string | undefined;
    let extras: string[] | undefined;

    if (exists) {
      const data = this.readToml(configPath);
      if (data) {
        const gwPort = defaultGatewayPort();
        if (this.detectHook(data, configDir, gwPort)) {
          hooked = true;
          details = `Routed to OmniCellRouter gateway (:${gwPort}/v1 via openai_base_url)`;
          mainValue = typeof data.model === 'string' ? data.model : undefined;
          // Extras echo from managed profiles ONLY. The merged catalog also
          // carries remaining stock OpenAI rows (Desktop allowlist / CLI
          // `/model`), and reading those as extras made the Clients "自定义"
          // chip wall claim the operator had selected every gpt-* slug.
          // Profiles are rewritten on setup as [...virtuals, ...extras];
          // virtual ids are stripped below so the console sees the real pick.
          extras = [
            ...new Set(
              this.listManagedProfiles(configDir)
                .map((p) => p.model)
                .filter((id) => id && id !== mainValue && !VIRTUAL_AUTO_IDS.has(id)),
            ),
          ];
        }
      } else {
        details = 'Config exists but could not be parsed as TOML — fix it manually, then re-apply';
      }
    } else {
      details = 'No Codex config file detected';
    }

    return {
      name: this.name,
      displayName: this.displayName,
      configPath,
      exists,
      hooked,
      backupExists,
      details,
      modelSlots: [{ key: 'main', value: hooked ? mainValue : undefined, default: 'auto' }],
      extraModels: extras,
    };
  }

  async setup(options?: {
    port?: number;
    models?: Record<string, string>;
    apiKey?: string;
    extraModels?: string[];
    virtualModels?: string[];
  }): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const configDir = path.dirname(configPath);
    const port = options?.port || defaultGatewayPort();
    const targetUrl = `http://127.0.0.1:${port}/v1`;
    const apiKey = options?.apiKey?.trim();
    if (!apiKey) {
      return {
        success: false,
        message:
          'Codex takeover requires a gateway API key (written into auth.json as OPENAI_API_KEY for the OCR hop)',
      };
    }

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
    const extras = (options?.extraModels || [])
      .map((id) => (id || '').trim())
      .filter((id) => id && id !== main && !VIRTUAL_AUTO_IDS.has(id));
    const virtuals = Array.isArray(options?.virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter((id) => options.virtualModels!.includes(id) && id !== main)
      : [...VIRTUAL_AUTO_IDS].filter((id) => id !== main);

    this.clearLegacyProvider(data, configDir);

    if (typeof data.openai_base_url === 'string' && data.openai_base_url && !data._ocr_previous_openai_base_url) {
      data._ocr_previous_openai_base_url = data.openai_base_url;
    }
    data.openai_base_url = targetUrl;
    data.model_provider = 'openai';
    data.model = main;

    delete data.profile;
    if (data.profiles) delete data.profiles;

    const ocrIds = [main, ...virtuals, ...extras];
    const { path: catalogPath, count: catalogCount } = this.writeMergedCatalog(configDir, ocrIds);
    data.model_catalog_json = catalogPath.replace(/\\/g, '/');

    const authNote = this.writeAuthApiKey(apiKey);
    this.writeToml(configPath, data);
    this.rewriteManagedProfiles(configDir, [...virtuals, ...extras]);

    return {
      success: true,
      message: `Codex configured to route via OCR (${targetUrl}, openai_base_url, ${catalogCount} picker entr${catalogCount === 1 ? 'y' : 'ies'} = OCR + stock OpenAI, model: ${main}). Fully quit and relaunch Codex CLI / ChatGPT Desktop so the picker reloads.${describeBackup(configPath)}${authNote}`,
    };
  }

  async teardown(): Promise<{ success: boolean; message: string }> {
    const configPath = this.getConfigPath();
    const configDir = path.dirname(configPath);
    const authPath = this.authPath();

    if (
      !fs.existsSync(configPath) &&
      this.listManagedProfiles(configDir).length === 0 &&
      !fs.existsSync(this.catalogPath(configDir)) &&
      !fs.existsSync(path.join(configDir, CodexClientAdapter.LEGACY_DESKTOP_CATALOG)) &&
      !fs.existsSync(`${authPath}.bak.ocr`)
    ) {
      return { success: false, message: `Configuration file not found at ${configPath}` };
    }

    const restored = fs.existsSync(configPath) ? restoreBackup(configPath) : false;
    if (fs.existsSync(configPath)) {
      const data = this.readToml(configPath);
      if (data === null) {
        return { success: false, message: `Could not parse Codex config at ${configPath}` };
      }
      this.strip(data, configDir);
      this.writeToml(configPath, data);
    }
    this.clearManagedProfiles(configDir);
    this.clearCatalog(configDir);
    this.clearLegacyDesktopCatalog(configDir);
    const authRestored = this.restoreAuthBackup();

    return {
      success: true,
      message: restored
        ? `Codex configuration restored from backup (${configPath}.bak.ocr)${authRestored ? '; auth.json restored' : ''}`
        : `Codex configuration decoupled from OCR.${authRestored ? ' auth.json restored.' : ''}`,
    };
  }

  private detectHook(data: TOML.JsonMap, configDir: string, gwPort: number): boolean {
    const base = typeof data.openai_base_url === 'string' ? data.openai_base_url : '';
    const viaBase =
      base.includes(`127.0.0.1:${gwPort}`) &&
      (data.model_provider === 'openai' || data.model_provider == null);
    const catalogPinned = this.isOurCatalogPath(data.model_catalog_json, configDir);
    // Legacy CLI hook (pre-unification) still counts as hooked until re-setup.
    const legacy = this.detectLegacyProvider(data, gwPort);
    return viaBase || catalogPinned || legacy;
  }

  private detectLegacyProvider(data: TOML.JsonMap, gwPort: number): boolean {
    const provider = (data.model_providers as TOML.JsonMap | undefined)?.[
      CodexClientAdapter.LEGACY_PROVIDER_ID
    ] as { base_url?: unknown } | undefined;
    const providerRouted =
      typeof provider?.base_url === 'string' && provider.base_url.includes(`127.0.0.1:${gwPort}`);
    return providerRouted || data.model_provider === CodexClientAdapter.LEGACY_PROVIDER_ID;
  }

  private strip(data: TOML.JsonMap, configDir: string): void {
    this.clearLegacyProviderKeys(data);
    const previous = data._ocr_previous_openai_base_url;
    if (typeof previous === 'string' && previous) {
      data.openai_base_url = previous;
    } else if (typeof data.openai_base_url === 'string' && data.openai_base_url.includes('127.0.0.1:')) {
      delete data.openai_base_url;
    }
    delete data._ocr_previous_openai_base_url;
    if (this.isOurCatalogPath(data.model_catalog_json, configDir)) {
      delete data.model_catalog_json;
    }
    const legacyCat = path.join(configDir, CodexClientAdapter.LEGACY_DESKTOP_CATALOG);
    if (typeof data.model_catalog_json === 'string') {
      const norm = (p: string) => path.normalize(p.replace(/\//g, path.sep)).toLowerCase();
      if (norm(data.model_catalog_json) === norm(legacyCat)) delete data.model_catalog_json;
    }
  }

  private clearLegacyProvider(data: TOML.JsonMap, configDir: string): void {
    this.clearLegacyProviderKeys(data);
    this.clearLegacyDesktopCatalog(configDir);
    // Drop leftover helper profiles from the old Desktop-only prefix.
    if (fs.existsSync(configDir)) {
      let names: string[];
      try {
        names = fs.readdirSync(configDir);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name.startsWith('chatgpt-') || !name.endsWith('.config.toml')) continue;
        try {
          fs.unlinkSync(path.join(configDir, name));
        } catch {
          /* ignore */
        }
      }
    }
  }

  private clearLegacyProviderKeys(data: TOML.JsonMap): void {
    const providers = data.model_providers as TOML.JsonMap | undefined;
    if (providers?.[CodexClientAdapter.LEGACY_PROVIDER_ID]) {
      delete providers[CodexClientAdapter.LEGACY_PROVIDER_ID];
      if (Object.keys(providers).length === 0) delete data.model_providers;
    }
    if (data.model_provider === CodexClientAdapter.LEGACY_PROVIDER_ID) {
      data.model_provider = 'openai';
    }
  }

  /**
   * Picker catalog: OCR-selected ids first (cloned stock template when the id
   * is official, else a synthetic row), then every remaining stock OpenAI
   * entry so Desktop’s allowlist and CLI `/model` both stay populated.
   */
  private writeMergedCatalog(
    configDir: string,
    ocrIds: string[],
  ): { path: string; count: number } {
    fs.mkdirSync(configDir, { recursive: true });
    const filePath = this.catalogPath(configDir);
    const stock = this.stockCatalogLoader();
    const stockBySlug = new Map(stock.map((m) => [String(m.slug), m]));
    const models: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let priority = 0;

    for (const slug of ocrIds) {
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const template = stockBySlug.get(slug);
      if (template) {
        models.push({
          ...template,
          priority: priority++,
          visibility: 'list',
          hidden: false,
          supported_in_api: true,
        });
      } else {
        models.push(this.syntheticCatalogEntry(slug, priority++));
      }
    }

    for (const row of stock) {
      const slug = String(row.slug);
      if (!slug || seen.has(slug)) continue;
      if (row.visibility != null && row.visibility !== 'list') continue;
      seen.add(slug);
      models.push({
        ...row,
        priority: priority++,
        visibility: 'list',
        hidden: false,
        supported_in_api: true,
      });
    }

    const tmp = `${filePath}.tmp.ocr`;
    fs.writeFileSync(tmp, JSON.stringify({ models }, null, 2));
    renameWithRetry(tmp, filePath);
    this.clearLegacyDesktopCatalog(configDir);
    return { path: filePath, count: models.length };
  }

  private syntheticCatalogEntry(slug: string, priority: number): Record<string, unknown> {
    return {
      slug,
      display_name: slug,
      description: `OmniCellRouter: ${slug}`,
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      ],
      shell_type: 'shell_command',
      visibility: 'list',
      hidden: false,
      supported_in_api: true,
      priority,
      availability_nux: null,
      upgrade: null,
      base_instructions: CodexClientAdapter.CATALOG_INSTRUCTIONS,
      supports_reasoning_summaries: true,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: 'freeform',
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      supports_parallel_tool_calls: true,
      experimental_supported_tools: [],
      context_window: 262_144,
      max_context_window: 262_144,
      input_modalities: ['text', 'image'],
    };
  }

  private writeAuthApiKey(apiKey: string): string {
    const authPath = this.authPath();
    const backupPath = `${authPath}.bak.ocr`;
    let data: Record<string, unknown> = {};
    if (fs.existsSync(authPath)) {
      try {
        data = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
      } catch {
        return ' (auth.json unreadable — gateway key not written; set OPENAI_API_KEY manually)';
      }
      if (!fs.existsSync(backupPath)) {
        try {
          fs.copyFileSync(authPath, backupPath);
        } catch {
          /* ignore */
        }
      }
    }
    data.OPENAI_API_KEY = apiKey;
    data.auth_mode = CodexClientAdapter.AUTH_MODE_API;
    delete data.tokens;
    try {
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      const tmp = `${authPath}.tmp.ocr`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameWithRetry(tmp, authPath);
      return fs.existsSync(backupPath) ? ` auth.json updated (backup ${backupPath}).` : ' auth.json updated.';
    } catch (err) {
      return ` (auth.json write failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  private restoreAuthBackup(): boolean {
    const authPath = this.authPath();
    const backupPath = `${authPath}.bak.ocr`;
    if (!fs.existsSync(backupPath)) return false;
    try {
      fs.copyFileSync(backupPath, authPath);
      fs.unlinkSync(backupPath);
      return true;
    } catch {
      return false;
    }
  }

  private rewriteManagedProfiles(configDir: string, modelIds: string[]): void {
    this.clearManagedProfiles(configDir);
    if (modelIds.length === 0) return;
    fs.mkdirSync(configDir, { recursive: true });
    const used = new Set<string>();
    for (const modelId of modelIds) {
      const stem = this.uniqueProfileStem(modelId, used);
      used.add(stem);
      const filePath = path.join(configDir, `${stem}.config.toml`);
      const body: TOML.JsonMap = {
        model: modelId,
        model_provider: 'openai',
      };
      const tmp = `${filePath}.tmp.ocr`;
      fs.writeFileSync(tmp, TOML.stringify(body));
      renameWithRetry(tmp, filePath);
    }
  }

  private clearManagedProfiles(configDir: string): void {
    for (const entry of this.listManagedProfiles(configDir)) {
      try {
        fs.unlinkSync(entry.filePath);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Profiles this adapter owns: `ocr-*.config.toml` whose body points at
   * openai (unified) or the retired omnicell-router provider.
   */
  private listManagedProfiles(configDir: string): Array<{ filePath: string; model: string }> {
    if (!fs.existsSync(configDir)) return [];
    let names: string[];
    try {
      names = fs.readdirSync(configDir);
    } catch {
      return [];
    }
    const out: Array<{ filePath: string; model: string }> = [];
    for (const name of names) {
      if (!name.startsWith(CodexClientAdapter.PROFILE_PREFIX) || !name.endsWith('.config.toml')) continue;
      const filePath = path.join(configDir, name);
      const data = this.readToml(filePath);
      if (!data) continue;
      if (
        data.model_provider !== 'openai' &&
        data.model_provider !== CodexClientAdapter.LEGACY_PROVIDER_ID
      ) {
        continue;
      }
      if (typeof data.model !== 'string' || !data.model) continue;
      out.push({ filePath, model: data.model });
    }
    return out;
  }

  private uniqueProfileStem(modelId: string, used: Set<string>): string {
    const safe = modelId.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
    let stem = `${CodexClientAdapter.PROFILE_PREFIX}${safe}`;
    if (!used.has(stem)) return stem;
    let n = 2;
    while (used.has(`${stem}-${n}`)) n += 1;
    return `${stem}-${n}`;
  }

  private clearCatalog(configDir: string): void {
    try {
      const p = this.catalogPath(configDir);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  private clearLegacyDesktopCatalog(configDir: string): void {
    try {
      const p = path.join(configDir, CodexClientAdapter.LEGACY_DESKTOP_CATALOG);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  private catalogPath(configDir: string): string {
    return path.join(configDir, CodexClientAdapter.CATALOG_FILE);
  }

  private isOurCatalogPath(value: unknown, configDir: string): boolean {
    if (typeof value !== 'string' || !value) return false;
    const norm = (p: string) => path.normalize(p.replace(/\//g, path.sep)).toLowerCase();
    return norm(value) === norm(this.catalogPath(configDir));
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
    const tmp = `${configPath}.tmp.ocr`;
    fs.writeFileSync(tmp, TOML.stringify(data));
    renameWithRetry(tmp, configPath);
  }
}
