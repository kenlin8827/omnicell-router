import type { LLMProvider, CallCredential } from '../providers/base.js';
import type { QuotaAdapterContext, QuotaProbeOutcome } from '../quota/types.js';
import type { ProviderConfig } from '../config/types.js';

/**
 * OCR plugin system: vendor-specific protocol knowledge (native
 * transports, signing chains, vendored vendor binaries) lives in USER-INSTALLED
 * plugins, never distributed by OCR core. One plugin type today
 * ('model-service'); the manifest `type` field is the extension axis.
 *
 * Trust boundary: a plugin is executable code loaded from the operator's
 * plugin directory — installing it IS the authorization. The host passes
 * credentials INTO the plugin per call (never hands over the credential
 * store); the plugin owns derived-token caching (its ProviderAccessToken
 * layer) and returns a plain LLMProvider so routing/breakers/captures work
 * with zero special cases.
 */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Extension axis — only 'model-service' is defined today. */
  type: 'model-service';
  /** Wire names this plugin provides executors for (e.g. ['qoder']). */
  wires: string[];
  /** Plain string, or a locale map ({"zh-CN": …, "en-US": …}) — the console
   *  picks by current UI locale and falls back to en-US / the raw value. */
  description?: string | Record<string, string>;
  /** Logo asset inside the package (served at /api/admin/plugins/:id/logo). */
  logo?: string;
  /** Provider presets this plugin can pre-provision (shown on the plugins page). */
  presets?: PluginProviderPreset[];
}

/** Options/result seam shared with opencode/probe.ts (concrete types live there). */
export interface PluginProbeOptions {
  provider?: string;
  model: string;
  apiKey: string;
  baseURL: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** A provider definition the plugin offers to pre-provision (e.g. one per
 *  region). Registration is ALWAYS an explicit operator action from the
 *  plugins page — the host never writes provider defs on install by itself
 *  (ADR-0010: providers.json is operator-owned). */
export interface PluginProviderPreset {
  presetId: string;
  /** Provider id to author (lowercase slug, becomes the defs-file key). */
  providerId: string;
  /** Human label — plain string or locale map (same contract as description). */
  displayName: string | Record<string, string>;
  npm: string;
  baseUrl: string;
  description?: string;
}

export interface ModelServicePlugin {
  manifest: PluginManifest;
  /** Build the chat executor for one wire the plugin declared. */
  createProvider(config: ProviderConfig): LLMProvider;
  /** Model-catalog pull in PullResult shape (auto-pull.ts contract). */
  pullModels?(id: string, opts: { pattern?: string; ids?: string[]; dryRun?: boolean }): Promise<{
    httpStatus: number;
    body: Record<string, unknown>;
  }>;
  /** Console Test-button probe (exchange + minimal call). */
  probe?(opts: PluginProbeOptions): Promise<{
    ok: boolean;
    kind: string;
    model?: string;
    latencyMs: number;
    httpStatus?: number;
    authHint?: boolean;
    upstreamBody?: string;
  }>;
  /**
   * Quota-check capability (ADR-0009 L-e — plugin knowledge layer). A plugin
   * that knows its vendor's usage endpoint declares it here; the quota
   * scheduler covers every provider on the plugin's wire that holds
   * credentials and has no higher-layer coverage (built-in table / built-in
   * adapter / operator `quotaProbes:`). Same contract as QuotaCodeAdapter.
   *
   * Windows SHOULD carry a `nameCode` from the closed console vocabulary
   * (session5h / sessionHours / modelSession / rolling / weekly / weekly7d /
   * modelWeekly / monthly / limit / credits / balance). The code drives both
   * display classes (short-period caps sort ahead of slower burns) and the
   * localized label (i18n `quotaPage.wn.*`); a window without one renders
   * under its raw `name` in the middle class band — functional, but the
   * operator sees the vendor's untranslated wording and loses the
   * period-aware ordering.
   */
  quotaCheck?(ctx: QuotaAdapterContext): Promise<QuotaProbeOutcome>;
}

/**
 * The backend capabilities a plugin may use, injected at load time
 * (createPlugin(host)) so the packaged plugin stays SELF-CONTAINED — it never
 * imports backend modules by path, because the unpacked plugin directory has
 * no `../../backend` sibling. Type-only references to backend shapes are fine
 * (erased at runtime); everything RUNTIME lives here.
 */
export interface ModelServicePluginHost {
  /** Error class the resilience/classifier layer recognizes (status/errorBody). */
  UpstreamError: new (options: { message: string; status?: number; errorBody?: string; provider?: string }) => Error & {
    status?: number;
    errorBody?: string;
    provider?: string;
  };
  /** Capture-plane emitters — same contract as observability/upstream-events.ts. */
  upstream: {
    requestOnce(ctx: unknown, args: { url: string; method: string; requestHeaders: Record<string, string>; requestBody: string; model?: string }): string | undefined;
    responseOnce(ctx: unknown, args: { spanId: string | undefined; url: string; method: string; status: number; statusText: string; responseHeaders: Headers; responseBody: string; model?: string }): void;
    failureOnce(ctx: unknown, args: { spanId: string | undefined; url: string; method: string; status: number; statusText: string; error: string; model?: string }): void;
    failureGuard(ctx: unknown, spanId: string | undefined, url: string, method: string, fn: () => Promise<unknown>, model?: string): Promise<unknown>;
  };
  constants: {
    /** Per-attempt upstream wall-clock cap (config default). */
    providerTimeoutMs: number;
  };
  /** Model-pull services (the auto-pull.ts seams, host-implemented). */
  pull: {
    getProviderNode(id: string): { options?: { baseURL?: string; apiKey?: string } } | undefined;
    getModelDefs(id: string): Record<string, unknown>;
    upsertModel(id: string, modelId: string, def: Record<string, unknown>): { success: boolean; [k: string]: unknown };
    matchesGlob(pattern: string, id: string): boolean;
    expandEnvTemplate(v: string | undefined): string | undefined;
    resolveCredentialKey(id: string): string | undefined;
    catalogToDef(m: Record<string, unknown>): Record<string, unknown>;
    enrichFromCatalog(models: unknown[], excludeProviderId: string): Promise<unknown[]>;
  };
}

/** One plugin known to the host — loaded, or the reason it could not load. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  type: string;
  wires: string[];
  description?: string | Record<string, string>;
  presets?: PluginProviderPreset[];
  /** Where the runtime code was loaded from (packaged extract or dev dir). */
  source: 'packaged' | 'dev';
  path: string;
  disabled?: boolean;
  loaded: boolean;
  error?: string;
}

export type { LLMProvider, CallCredential };
