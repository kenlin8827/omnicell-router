import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import TOML from '@iarna/toml';
import {
  ClientAdapter,
  createBackup,
  describeBackup,
  restoreBackup,
  defaultGatewayPort,
  OCR_WATERMARK,
} from './base.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import { ClientHookStatus, VIRTUAL_AUTO_IDS } from '../types.js';
import { resolveClientModelMeta } from './model-meta.js';
/**
 * Hook target: Kimi CLI (Moonshot, `~/.kimi-code/bin/kimi`). The installed
 * kimi-code build (v2.4.1 verified 2026-11) reads `~/.kimi-code/config.toml`
 * — NOT the `~/.kimi/config.toml` path the vendor docs describe (older
 * kimi-cli layout; both may exist on disk, only the -code one is live). A
 * platform is a `[providers.<id>]` table (type `openai` for OpenAI Chat
 * Completions endpoints — the `openai_legacy` name belongs to the archived
 * kimi-cli product, which kimi-code never accepted) plus `[models."<key>"]`
 * entries whose `provider` field names it, and the top-level `default_model`
 * pin. We register ONE managed provider (`omnicell-router`) on the gateway's
 * /v1 endpoint and one model entry per exposed model (`omnicell-router` =
 * main slot, `omnicell-router-<id>` for extras + virtual tier ids), each
 * carrying the gateway-issued key.
 * The user's managed Kimi Code provider and its `services.moonshot_search` /
 * `moonshot_fetch` blocks are untouched — under a third-party platform Kimi
 * simply falls back to local fetching for `FetchURL` (vendor-documented
 * behavior). TOML has no comment-preserving rewrite, so setup does a full
 * parse/stringify round-trip; the pre-write backup (`createBackup`) is the
 * safety net.
 */
export class KimiClientAdapter implements ClientAdapter {
  name = 'kimi' as const; // wire identity — stable across renames; the PRODUCT is Kimi Code CLI (Moonshot).
  hookKind = 'config' as const;
  displayName = 'Kimi Code CLI';

  /**
   * Compatibility floor = the kimi-code changelog floor (0.2.0, 2026-05-26):
   * the `~/.kimi-code/config.toml` contract, the `openai` provider type and
   * the required per-model `max_context_size` are unchanged since. NOT the
   * version verified on this machine. NOTE: `openai_legacy` is the ARCHIVED
   * kimi-cli product's name — that lineage reads `~/.kimi/` and is a
   * different tool; kimi-code never accepted it.
   */
  minVersion = '0.2.0';
  versionCmd = ['kimi', '--version'];
  /** Provider table id this adapter owns inside `[providers]` — the full
   *  product name, never the OCR abbreviation: the vendor's own managed
   *  entries use `managed:kimi-code` style ids, and bare vendor names
   *  ('kimi', 'openai') collide with real provider namespaces. */
  private static readonly PROVIDER_ID = 'omnicell-router';
  /** Model-entry key of the main slot inside `[models]`. */
  private static readonly MAIN_KEY = 'omnicell-router';
  /** Prefix for extra-model entry keys (`omnicell-router-<gateway model id>`). */
  private static readonly EXTRA_PREFIX = `${KimiClientAdapter.MAIN_KEY}-`;

  getConfigPath(): string {
    return path.join(os.homedir(), '.kimi-code', 'config.toml');
  }

  async getStatus(): Promise<Omit<ClientHookStatus, 'hookKind'>> {
    const configPath = this.getConfigPath();
    const exists = fs.existsSync(configPath);
    const backupExists = fs.existsSync(`${configPath}.bak.ocr`);
    let hooked = false;
    let details = 'Direct Kimi platform connection';
    let mainValue: string | undefined;
    let extras: string[] | undefined;
    let data: TOML.JsonMap | null = null;

    if (exists) {
      data = this.readToml(configPath);
      if (data) {
        const gwPort = defaultGatewayPort();
        // Tables index to the lib's AnyJson union; this adapter owns the
        // managed shapes, so the reads converge through explicit casts. The
        // base_url read stays typeof-guarded: a hand-edited scalar would make
        // .includes throw, and getAllClientStatuses fans getStatus through a
        // bare Promise.all — one bad config would 500 the whole endpoint.
        const provider = (data.providers as TOML.JsonMap | undefined)?.[
          KimiClientAdapter.PROVIDER_ID
        ] as { base_url?: unknown } | undefined;
        const providerRouted =
          typeof provider?.base_url === 'string' && provider.base_url.includes(`127.0.0.1:${gwPort}`);
        if (data[OCR_WATERMARK] || providerRouted) {
          hooked = true;
          details = `Routed to OmniCellRouter gateway (:${gwPort}/v1, chat_completions)`;
          const models = data.models as TOML.JsonMap | undefined;
          const main = models?.[KimiClientAdapter.MAIN_KEY] as { model?: string } | undefined;
          mainValue = main?.model ? String(main.model) : undefined;
          extras = Object.keys(models || {})
            .filter(
              k =>
                k.startsWith(KimiClientAdapter.EXTRA_PREFIX) &&
                ((models as TOML.JsonMap)[k] as { provider?: unknown } | undefined)?.provider ===
                  KimiClientAdapter.PROVIDER_ID &&
                !VIRTUAL_AUTO_IDS.has(k.slice(KimiClientAdapter.EXTRA_PREFIX.length))
            )
            .map(k => k.slice(KimiClientAdapter.EXTRA_PREFIX.length));
        }
      } else {
        details = 'Config exists but could not be parsed as TOML — fix it manually, then re-apply';
      }
    } else {
      details = 'No Kimi config file detected';
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
      return { success: false, message: 'Kimi takeover requires a gateway API key (the [providers."omnicell-router"] table carries it)' };
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
    // Virtual tier entries ride as their own `omnicell-router-<id>` model entries: the
    // omitted form (`virtualModels` undefined) injects the full auto block —
    // Kimi's /model picker lists every `[models]` entry, so the tier aliases
    // stay switchable in-client.
    const extras = (options?.extraModels || [])
      .map(id => (id || '').trim())
      .filter(id => id && id !== main && !VIRTUAL_AUTO_IDS.has(id));
    const virtuals = Array.isArray(options?.virtualModels)
      ? [...VIRTUAL_AUTO_IDS].filter(id => options.virtualModels!.includes(id) && id !== main)
      : [...VIRTUAL_AUTO_IDS].filter(id => id !== main);
    const contextWindow =
      options?.contextWindow && options.contextWindow > 0 ? Math.floor(options.contextWindow) : undefined;
    // Hand-edited TOML may carry a scalar or array where a table belongs;
    // property writes on primitives throw in ESM strict mode, so normalize
    // to a table — the original value is replaced when the table re-assigns.
    const asTable = (v: unknown): TOML.JsonMap =>
      v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as TOML.JsonMap) : {};

    const providers = asTable(data.providers);
    // v2.4.1 provider vocabulary: kimi | anthropic | openai | openai_responses |
    // google-genai | vertexai — `openai_legacy` was the older kimi-cli name and
    // leaves the model with no inferable wire protocol ("must declare a wire
    // protocol" at startup).
    providers[KimiClientAdapter.PROVIDER_ID] = {
      type: 'openai',
      base_url: targetUrl,
      api_key: apiKey,
    };
    data.providers = providers;

    const models = asTable(data.models);
    // Per-model effort support comes from the live gateway truth (same
    // resolver the pi adapter uses): concrete registered models get their
    // real supported subset, tier aliases / combos / unresolved ids get the
    // permissive full ladder (the gateway clamps per request — see
    // model-meta.ts). Non-reasoning models get no thinking fields at all.
    const meta = await resolveClientModelMeta([...new Set([main, ...virtuals, ...extras])]);
    const KIMI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    const entry = (modelId: string): TOML.JsonMap => {
      const m = meta[modelId];
      const e: TOML.JsonMap = {
        provider: KimiClientAdapter.PROVIDER_ID,
        model: modelId,
        // Required on every entry (docs: "must be at least 1"); the plain
        // `ocr setup` CLI passes no window, so fall back to 256K.
        max_context_size: contextWindow ?? 262144,
      };
      if (m && !m.reasoning) return e;
      const map = m?.thinkingLevelMap;
      e.capabilities = ['thinking'];
      e.support_efforts = KIMI_EFFORTS.filter(lvl => !map || map[lvl] != null);
      return e;
    };
    for (const key of this.managedKeys(models)) delete models[key];
    models[KimiClientAdapter.MAIN_KEY] = entry(main);
    for (const id of virtuals) models[`${KimiClientAdapter.EXTRA_PREFIX}${id}`] = entry(id);
    for (const id of extras) models[`${KimiClientAdapter.EXTRA_PREFIX}${id}`] = entry(id);
    data.models = models;

    // Take over the default-model pin; the previous value is restored on teardown.
    if (typeof data.default_model === 'string' && data.default_model && !data._ocr_previous_default_model) {
      data._ocr_previous_default_model = data.default_model;
    }
    data.default_model = KimiClientAdapter.MAIN_KEY;
    // Same for the subagent default: a dangling reference to the vendor's
    // managed provider breaks SESSION STARTUP (config fails loudly, vendor
    // contract) whenever that login expires — the hook must not leave startup
    // hostage to an unrelated OAuth session. The user's own `[secondary_model]`
    // shape (pool tables, hints) is untouched; only the default pin moves.
    const secondary = asTable(data.secondary_model);
    if (typeof secondary.default_model === 'string' && secondary.default_model && !data._ocr_previous_secondary_model) {
      data._ocr_previous_secondary_model = secondary.default_model;
    }
    if (Object.keys(secondary).length > 0 || data.secondary_model !== undefined) {
      secondary.default_model = KimiClientAdapter.MAIN_KEY;
      data.secondary_model = secondary;
    }
    data[OCR_WATERMARK] = true;

    this.writeToml(configPath, data);

    const backupNote = describeBackup(configPath);
    return {
      success: true,
      message: `Kimi CLI configured to route via OCR (${targetUrl}, ${1 + virtuals.length + extras.length} model entr${virtuals.length + extras.length === 0 ? 'y' : 'ies'}, default: ${KimiClientAdapter.MAIN_KEY}).${backupNote}`,
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
      return { success: false, message: `Could not parse Kimi config at ${configPath}` };
    }

    // Restore-then-strip: a backup taken during a REPEAT setup snapshots the
    // already-hooked config, so restore alone would leave the hook in place
    // (same class of bug the pi and grok adapters fixed). The managed keys are
    // stripped from whatever restore produced — or from the live config when
    // no backup exists — and that result is what gets written back.
    this.strip(data);
    this.writeToml(configPath, data);

    return {
      success: true,
      message: restored
        ? `Kimi configuration restored from backup (${configPath}.bak.ocr)`
        : 'Kimi configuration decoupled from OCR. Reverted to standard configuration.',
    };
  }

  /** Remove every OCR-owned key from a parsed config (teardown core). */
  private strip(data: TOML.JsonMap): void {
    const models = data.models as TOML.JsonMap | undefined;
    if (models) {
      for (const key of this.managedKeys(models)) delete models[key];
      if (Object.keys(models).length === 0) delete data.models;
    }
    const providers = data.providers as TOML.JsonMap | undefined;
    if (providers?.[KimiClientAdapter.PROVIDER_ID]) {
      delete providers[KimiClientAdapter.PROVIDER_ID];
      if (Object.keys(providers).length === 0) delete data.providers;
    }
    const previousSecondary = data._ocr_previous_secondary_model;
    // Property writes on primitives throw in ESM strict mode, so normalize to a table —
    // mirroring the asTable guard setup uses.
    const secondary: TOML.JsonMap =
      data.secondary_model !== null && typeof data.secondary_model === 'object' && !Array.isArray(data.secondary_model)
        ? (data.secondary_model as TOML.JsonMap)
        : {};
    if (typeof previousSecondary === 'string' && previousSecondary) {
      secondary.default_model = previousSecondary;
      data.secondary_model = secondary;
    } else if (secondary.default_model === KimiClientAdapter.MAIN_KEY) {
      // No recorded previous: setup created this pin (even on a table that had none), so
      // without a backup to restore from, dropping it is the only way to avoid a dangling
      // reference to the provider teardown just deleted — the same startup failure the
      // takeover exists to prevent.
      delete secondary.default_model;
      if (Object.keys(secondary).length === 0) delete data.secondary_model;
      else data.secondary_model = secondary;
    }
    delete data._ocr_previous_secondary_model;
    const previous = data._ocr_previous_default_model;
    if (typeof previous === 'string' && previous) {
      data.default_model = previous;
    } else if (data.default_model === KimiClientAdapter.MAIN_KEY) {
      delete data.default_model;
    }
    // Unconditional: the marker must not survive even if the user hand-deleted
    // the default pin between setup and teardown.
    delete data._ocr_previous_default_model;
    delete data[OCR_WATERMARK];
  }

  /**
   * Model-entry keys currently owned by this adapter: the reserved main key
   * plus `omnicell-router-*` entries carrying OUR provider marker. Entries
   * merely NAMED `omnicell-router-*` are the user's own — a prefix-only
   * sweep would delete them twice (at setup, then again in teardown).
   */
  private managedKeys(models: TOML.JsonMap | undefined): string[] {
    return Object.keys(models || {}).filter(k => {
      if (k === KimiClientAdapter.MAIN_KEY) return true;
      if (!k.startsWith(KimiClientAdapter.EXTRA_PREFIX)) return false;
      const entry = (models as TOML.JsonMap)[k] as TOML.JsonMap | undefined;
      return entry?.provider === KimiClientAdapter.PROVIDER_ID;
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
