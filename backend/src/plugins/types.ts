import type http from 'node:http';
import type net from 'node:net';

import type { LLMProvider, CallCredential } from '../providers/base.js';
import type { QuotaAdapterContext, QuotaProbeOutcome } from '../quota/types.js';
import type { ProviderConfig } from '../config/types.js';

/**
 * OCR plugin system: vendor-specific protocol knowledge (native
 * transports, signing chains, vendored vendor binaries) lives in USER-INSTALLED
 * plugins, never distributed by OCR core. Two plugin types today:
 * 'model-service' (outbound provider executors) and 'client-gateway'
 * (inbound native-protocol gateways, ADR-0017); the manifest `type` field
 * is the extension axis.
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
  /** Extension axis — 'model-service' (outbound provider executors) or
   *  'client-gateway' (inbound native-protocol gateway, ADR-0017). */
  type: 'model-service' | 'client-gateway';
  /** Wire names this plugin provides executors for (e.g. ['qoder']).
   *  model-service only; a client-gateway manifest leaves it empty. */
  wires: string[];
  /** SNI hosts this client-gateway claims on the forward proxy (display
   *  metadata only — the runtime truth is the module's `hosts`). */
  hosts?: string[];
  /** Plain string, or a locale map ({"zh-CN": …, "en-US": …}) — the console
   *  picks by current UI locale and falls back to en-US / the raw value. */
  description?: string | Record<string, string>;
  /** Logo asset inside the package (served at /api/admin/plugins/:id/logo). */
  logo?: string;
  /** Provider presets this plugin can pre-provision (shown on the plugins page). */
  presets?: PluginProviderPreset[];
  /** Operator-facing configuration fields (ADR-0017). Flat primitives only —
   *  the console renders the settings form generically from this; values are
   *  stored as a plugin artifact (<pluginsRoot>/config/<id>.json), never in
   *  the frozen config.yaml. */
  configSchema?: PluginConfigField[];
}

/** One flat field of a plugin's operator-facing configuration. Primitives
 *  only: the console renders string/number/boolean/string[]/enum inputs
 *  generically. `title`/`desc` follow the manifest locale-map convention. */
export interface PluginConfigField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'enum';
  /** Falls back per type when unset or when a stored value fails validation
   *  (string '', number 0, boolean false, string[] [], enum values[0]). */
  default?: string | number | boolean | string[];
  /** number: inclusive bounds. */
  min?: number;
  max?: number;
  /** enum: the allowed values. */
  values?: string[];
  title?: string | Record<string, string>;
  desc?: string | Record<string, string>;
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
  /** How-to hint shown above the key form in the console add-credential
   *  dialog — plain string or locale map (same contract as displayName).
   *  Plugins use it for "where to get this key" guidance (qoder's PAT) or
   *  fallback-tab explanations (workbuddy: web-login first, pasted token
   *  as fallback). Optional; absent = the dialog renders no hint line. */
  keyHint?: string | Record<string, string>;
}

/** Credential methods the console may offer for this plugin's providers, in
 *  display order; the FIRST entry is the default selection. 'webLogin'
 *  requires the webLogin capability below. Absent = legacy behavior (the key
 *  form always renders, the web tab appears after it when webLogin exists). */
export type PluginAuthType = 'webLogin' | 'key';

export interface ModelServicePlugin {
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
  /** Web authorization (device flow) driven from the console connect card —
   *  the plugin is the ONLY owner of its vendor's login protocol; core just
   *  relays start/poll (generic seam, same shape as probe). A done poll
   *  returns the fresh token so the console route can wire it into the
   *  credential store. */
  webLogin?: {
    /** Begin a login session and return the authorize URL for the browser. */
    start(opts: { baseURL: string }): Promise<{ authUrl: string }>;
    /** Poll the in-flight session once. done+token = login finished and the
     *  plugin has already persisted its long-lived token bundle. */
    poll(opts: { baseURL: string }): Promise<{ done: boolean; error?: string; token?: string }>;
    /** Optional manual completion for off-box authorization: the operator
     *  opens the authorize URL on another machine (or copies a token from the
     *  vendor console) and pastes the resulting token/code back. Absent = the
     *  vendor flow has no user-visible token — the console hides the paste
     *  box and relies on poll alone. */
    submit?(opts: { baseURL: string; code: string }): Promise<{ ok: boolean; error?: string; token?: string }>;
  };

  /** Ordered credential methods for the console connect card (see PluginAuthType). */
  authTypes?: PluginAuthType[];
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
  /** Optional: notified after the operator saves plugin settings; the merged
   *  values arrive pre-validated (same object `host.config()` returns). */
  onConfigChange?(config: Record<string, unknown>): void | Promise<void>;
}
// ── generic plugin-traffic feed shapes (Wireshark dissector model) ──

/** One RAW captured exchange in a client-gateway plugin's traffic feed:
 *  the feed stores bytes, decode runs at read time. Bodies are base64,
 *  capped by the writing plugin. */
export interface TrafficExchange {
  ts?: string;
  authority?: string;
  method?: string;
  path?: string;
  reqContentType?: string;
  resContentType?: string;
  status?: number;
  durationMs?: number;
  /** Which upstream leg relayed the exchange (h2 / h1 / h1-fallback). */
  leg?: string;
  reqBody?: string;
  resBody?: string;
  reqTruncated?: boolean;
  resTruncated?: boolean;
  [k: string]: unknown;
}

/** One decoded protocol layer a dissector produced for an exchange. */
export interface TrafficLayer {
  name: string;
  /** Which side of the exchange this layer decodes. REQUIRED in practice:
   *  without it the console cannot keep the request tree out of the response
   *  tab, and a row with an empty response body appears to decode anyway. */
  side?: 'req' | 'res';
  frames?: unknown[];
  [k: string]: unknown;
}

/** Dissector output: the plugin's protocol knowledge applied to one raw
 *  exchange, rendered by the console's generic protocol-traffic tab. */
export interface DissectedExchange {
  decoder: string;
  layers: TrafficLayer[];
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
  /** Operator configuration, merged (defaults ← stored artifact, validated).
   *  Call-time lookup — always current after a console save. */
  config(): Record<string, unknown>;
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
/**
 * Client-gateway plugin contract (the second plugin type, ADR-0017).
 *
 * A gateway claims whole SNI hosts on the inbound forward proxy and handles
 * the DECRYPTED traffic of those hosts itself — native Connect/protobuf
 * wires (Cursor) etc. It sees node-http req/res on the h1 leg and the
 * http2 compatibility API (same shape) on the h2 leg; `handle` owns the
 * full request lifecycle (body read, terminal write, error frames). A
 * gateway that cannot answer a path must relay it upstream itself — the
 * core falls back to h1 forwarding, which h2-only vendors reject.
 */
export interface ClientGatewayPlugin {
  /** Exact SNI hosts claimed (e.g. ['api2.cursor.sh']). */
  readonly hosts: readonly string[];
  /** Per-request admission (host already scoped by the registry lookup). */
  match(info: { method?: string; url?: string; headers: http.IncomingHttpHeaders }): boolean;
  /** Handle the decrypted request to completion. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  /**
   * Optional: OWN an `Upgrade:` handshake on a claimed host (WebSocket or any
   * other upgrade protocol). `true` = the gateway took the socket and owns the
   * stream from here; `false` = fall through to the transparent upgrade relay
   * (ADR-0008 §3), which is what happens when this hook is absent.
   *
   * Ownership is total: the gateway writes the `101` itself (the relay's own
   * byte-verbatim splice is not involved), so a gateway that returns `true`
   * and then fails must destroy the socket — the core will not write an error
   * envelope over a stream it no longer owns.
   */
  handleUpgrade?(ctx: ClientGatewayUpgradeContext): boolean | Promise<boolean>;
  /** Optional decoder (Wireshark dissector model): the console's generic
   *  protocol-traffic tab lists every client gateway that declares one and
   *  calls it at READ time on the raw feed — never at capture time. A plugin
   *  that does not write a traffic feed has no dissector and no tab entry.
   *  Feed layout: day-JSONL files under
   *  `<ocrHome>/plugins/traffic/<pluginId>/<YYYY-MM-DD>.jsonl`, one base64-
   *  capped TrafficExchange per row, newest-first tail served by the route. */
  dissect?(exchange: TrafficExchange): DissectedExchange;
  /** Optional: notified after the operator saves plugin settings; the merged
   *  values arrive pre-validated (same object `host.config()` returns). */
  onConfigChange?(config: Record<string, unknown>): void | Promise<void>;
}

/** One decrypted `Upgrade:` handshake handed to a client gateway. */
export interface ClientGatewayUpgradeContext {
  /** The DECRYPTED client socket (TLS already terminated by the proxy). */
  socket: net.Socket;
  /**
   * Raw request head exactly as the client sent it — request line + headers +
   * CRLFCRLF, followed by any bytes the client pipelined behind the handshake.
   * Byte-verbatim, so nothing about the handshake was re-serialized.
   */
  head: Buffer;
  /** Target host/port parsed from the head's Host header (the relay's dial target). */
  host: string;
  port: number;
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

/** Sink the gateway host hands a gateway for ONE canonical chat completion.
 *  Terminal-send discipline holds: exactly one onJson XOR chunks→onEnd. */
export interface GatewayChatSink {
  /** One canonical OpenAI-shaped SSE frame, exactly as the /v1 wire writes it
   *  (`data: {…}\n\n`, terminating `data: [DONE]\n\n`). */
  onChunk(frame: string): void;
  /** Non-stream terminal (stream:false). */
  onJson(status: number, payload: unknown): void;
  /** Stream terminal (after the last onChunk). */
  onEnd(): void;
}

/**
 * Host SDK for client-gateway plugins — self-contained capabilities only
 * (same rule as ModelServicePluginHost: a packaged plugin never imports
 * backend modules by path).
 */
export interface ClientGatewayHost {
  log(...args: unknown[]): void;
  /** The live OCR home directory (bookkeeping, CA material paths). */
  ocrHome(): string;
  /** Operator configuration, merged (defaults ← stored artifact, validated).
   *  Call-time lookup — always current after a console save. */
  config(): Record<string, unknown>;
  /** Run one canonical OpenAI-shaped chat completion through the SAME
   *  dispatch pipeline as /v1/chat/completions (model resolution, tiers,
   *  breakers, captures all apply). `signal` aborts with the client. */
  chat(body: Record<string, unknown>, sink: GatewayChatSink, signal?: AbortSignal): Promise<void>;
  /** Current routing surface for AvailableModels-style fabrication. */
  catalog(): {
    /** Virtual tier ids in canonical order (auto/lite/plus/pro/ultra). */
    tiers: string[];
    /** Registered model refs (gateway-visible ids, all kinds). */
    models: { id: string; label?: string }[];
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
  /** Logo asset inside the package (served at /api/admin/plugins/:id/logo). */
  logo?: string;
  /** Where the runtime code was loaded from (packaged extract or dev dir). */
  source: 'packaged' | 'dev';
  path: string;
  disabled?: boolean;
  loaded: boolean;
  /** Wall-clock ms when this view's code was imported into the runtime (undefined for disabled/failed rows). */
  loadedAt?: number;
  error?: string;
}

export type { LLMProvider, CallCredential };
