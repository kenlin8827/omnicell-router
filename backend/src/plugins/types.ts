import type http from 'node:http';
import type net from 'node:net';

import type { CallCredential, UpstreamEventContext } from '../providers/base.js';
import type { ModelRegistration } from '../config/types.js';
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse } from '../types/openai.js';
import type { ClientAdapter } from '../cli/clients/base.js';
import type { QuotaAdapterContext, QuotaProbeOutcome } from '../quota/types.js';
import type { ProviderConfig } from '../config/types.js';
import type { AccessTap } from '../forward-proxy/access-log.js';

/**
 * OCR plugin system: vendor-specific protocol knowledge (native
 * transports, signing chains, vendored vendor binaries) lives in USER-INSTALLED
 * plugins, never distributed by OCR core. Three extension axes today:
 * 'model-service' (outbound provider executors), 'client-gateway' (inbound
 * native-protocol gateways, ADR-0017) and 'client-adapter' (a Client Hub hook,
 * ADR-0027).
 *
 * A package declares ONE OR MORE of them through `parts` (ADR-0028). The axes
 * are independent capabilities, not a taxonomy of package kinds, so a single
 * install can legitimately fill more than one slot — OpenCode proxy mode is an
 * ingress hook (client-adapter) AND the traffic owner on the claimed hosts
 * (client-gateway), and splitting it into two packages forced the operator to
 * install one to make the other work. `type` remains as the single-part
 * shorthand; a package never declares both.
 *
 * Trust boundary: a plugin is executable code loaded from the operator's
 * plugin directory — installing it IS the authorization. The host passes
 * credentials INTO the plugin per call (never hands over the credential
 * store); the plugin owns derived-token caching (its ProviderAccessToken
 * layer) and returns a plain LLMProvider so routing/breakers/captures work
 * with zero special cases.
 */

/** The three extension axes a plugin can occupy (ADR-0017 / ADR-0027). */
export type PluginType = 'model-service' | 'client-gateway' | 'client-adapter';

/**
 * One slot a package fills. `wires` belongs to a model-service part, `hosts`
 * to a client-gateway part; a client-adapter part carries neither (its
 * contribution is a Client Hub hook, not a wire or a claim).
 */
export interface PluginPart {
  type: PluginType;
  /** Wire names this part provides executors for (e.g. ['qoder']).
   *  Required non-empty on a model-service part, rejected elsewhere. */
  wires?: string[];
  /** SNI hosts this part claims on the forward proxy. Required non-empty on a
   *  client-gateway part, rejected elsewhere. */
  hosts?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /** Plugin contract version (ADR-0017 §6). Must EQUAL the host's
   *  `SUPPORTED_PLUGIN_API` — v1 promises no legacy or forward compatibility. */
  apiVersion: number;
  /** Single-part shorthand (ADR-0028). Present on every one-axis package;
   *  a multi-part package declares `parts` instead and omits this — the two
   *  are mutually exclusive so the manifest never states its axes twice. */
  type?: PluginType;
  /** The slots this package fills, in load order (ADR-0028). Absent = the
   *  single part described by `type`. At most one entry per `type`. */
  parts?: PluginPart[];
  /** Wire names this plugin provides executors for (e.g. ['qoder']).
   *  Single-part form of `parts[].wires`; model-service only. */
  wires?: string[];
  /** SNI hosts this client-gateway claims on the forward proxy (display
   *  metadata only — the runtime truth is the module's `hosts`). Single-part
   *  form of `parts[].hosts`. */
  hosts?: string[];
  /** Plain string, or a locale map ({"zh-CN": …, "en-US": …}) — the console
   *  picks by current UI locale and falls back to en-US / the raw value. */
  description?: string | Record<string, string>;
  /** Operator-facing text for the setup advisories THIS package emits, keyed by
   *  the warning `code` it returns from `setup`/`teardown` (ADR-0017). Same
   *  locale-map convention as `description`; `{param}` slots are filled from the
   *  warning's `params`. Core-owned codes (`ca_not_trusted`, …) keep core
   *  wording — a package declares only codes it introduced. */
  warningLabels?: Record<string, string | Record<string, string>>;
  /** Package-owned client presentation texts (ADR-0027): success toasts, the
   *  card hint, per-reasonCode failure copy and family-card labels — every
   *  string the console used to hardcode per client id. Core must never
   *  string-reference a package client id; the copy travels with the package. */
  clientText?: ClientTextManifest;
  /** Roster sort key among contributed hooks (lower sorts first). Absent =
   *  alphabetical after every ranked hook; the core popularity table
   *  (`utils/popularity.ts`) stays host/core-only. */
  clientRank?: number;
  logo?: string;
  /** Provider presets this plugin can pre-provision (shown on the plugins page). */
  presets?: PluginProviderPreset[];
  /** Operator-facing configuration fields (ADR-0017). Flat primitives only —
   *  the console renders the settings form generically from this; values are
   *  stored as a plugin artifact (<pluginsRoot>/config/<id>.json), never in
   *  the frozen config.yaml. */
  configSchema?: PluginConfigField[];
  /** Optional grouping for those fields. Declared ONCE here and referenced by
   *  id from each field (`section`), never repeated per field — a per-field
   *  title would be a drift twin. Rendering order is array order; fields that
   *  name no section render first, ungrouped. */
  configSections?: PluginConfigSection[];
}

/**
 * What a MULTI-PART package's `createPlugin(host)` returns (ADR-0028): one
 * field per part it declared, all produced by the single call. The host calls
 * `createPlugin` ONCE and refuses to load a package whose declared part is
 * missing from the result — a half-registered package would look installed
 * while answering nothing.
 */
export interface PluginEntryResult {
  /** The 'model-service' part (executor factory for `wires`). */
  provider?: ModelServicePlugin;
  /** The 'client-gateway' part (host claims + request handling). */
  gateway?: ClientGatewayPlugin;
  /** The 'client-adapter' part (Client Hub hook). */
  clientAdapter?: ClientAdapter;
}

/** One group of operator-facing fields. `advanced` moves the whole group behind
 *  a collapsed disclosure: hidden fields keep their values (the same rule as
 *  `visibleWhen`), so collapsing never discards operator input. */
export interface PluginConfigSection {
  id: string;
  /** Locale-text group heading. Omitted = a visual boundary with no heading. */
  title?: string | Record<string, string>;
  advanced?: boolean;
  /** Optional hint under the heading (the drawer/card shows it as an info
   *  tip). Same locale-map convention as `title`. */
  desc?: string | Record<string, string>;
}

/** The closed widget vocabulary the CONSOLE owns (ADR-0017 §7). A plugin names
 *  a control, never a layout, ordering or markup: 'text' is the default for a
 *  `string`, 'textarea' a multi-line box, 'model' a single model-ref picker
 *  bound to the gateway catalog, 'models' a multi-pick list of model refs.
 *  A control that cannot drive the field's type fails the manifest. */
export type PluginConfigControl = 'text' | 'textarea' | 'model' | 'models' | 'segmented' | 'apiKey';

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
  /** enum: value → display label, same string-or-locale-map convention as
   *  `title`. Keys must be declared `values`; an unlabeled value renders raw.
   *  Without this the console can only print machine values ('follow'), which
   *  is the whole point of the map — the value carries operator-facing meaning. */
  enumLabels?: Record<string, string | Record<string, string>>;
  /** Widget override from the closed console vocabulary (see
   *  `PluginConfigControl`). Omitted = the type's default control. */
  control?: PluginConfigControl;
  /** Id of the `configSections` entry this field belongs to. Omitted = the
   *  leading ungrouped block. */
  section?: string;
  /** Display-only predicate: the console shows this field while the referenced
   *  field holds one of the listed values. Exactly one of `equals` / `in`.
   *  The referenced field must be an enum or boolean declared in this schema;
   *  `equals`/`in` values must be part of it. A hidden field is NOT cleared and
   *  NOT skipped by validation/merge — hiding is cosmetic, so toggling a mode
   *  back never loses what the operator entered. */
  visibleWhen?: { key: string; equals?: string | boolean; in?: (string | boolean)[] };
  /** Quick-mode marker: a field the console shows in the settings drawer's
   *  QUICK view (the essentials a typical operator needs). Fields without it
   *  render only in the ADVANCED view. A schema with no `essential` field at
   *  all has no quick view — the drawer skips the toggle and shows everything
   *  (the historical behavior). Pure display, like `visibleWhen`: storage,
   *  validation and merge are untouched either way. */
  essential?: boolean;
  title?: string | Record<string, string>;
  desc?: string | Record<string, string>;
  /** Where the console edits this field. `drawer` (default) = the plugin
   *  settings drawer; `card` = the Client Hub card the hook backs (its catalog
   *  editor), rendered generically from key/control/title/desc/default;
   *  `none` = stored but not edited (dead config for this hook). */
  placement?: 'drawer' | 'card' | 'none';
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
  /**
   * OCR protocol id (`openai-chat`, `anthropic-messages`, `systemone`, or a bare
   * plugin wire such as `qoder`). Never an SDK package. Older plugin builds
   * may still send the retired spelling on `npm` below.
   */
  protocol: string;
  /** Retired spelling of `protocol`, accepted from older plugin builds. */
  npm?: string;
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

/** Chat is the versioned external plugin contract, never the core IR. */
export interface ChatPluginProvider {
  name: string;
  createCompletion(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<ChatCompletionResponse>;
  createStream?(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: UpstreamEventContext,
    credential?: CallCredential,
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
}

export interface ModelServicePlugin {
  /** Build the versioned Chat executor for one declared plugin wire. */
  createProvider(config: ProviderConfig): ChatPluginProvider;
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
    responseOnce(ctx: unknown, args: { exchangeId: string | undefined; url: string; method: string; status: number; statusText: string; responseHeaders: Headers; responseBody: string; model?: string }): void;
    failureOnce(ctx: unknown, args: { exchangeId: string | undefined; url: string; method: string; status: number; statusText: string; error: string; model?: string }): void;
    failureGuard(ctx: unknown, exchangeId: string | undefined, url: string, method: string, fn: () => Promise<unknown>, model?: string): Promise<unknown>;
  };
  constants: {
    /** Per-attempt upstream wall-clock cap (config default). */
    providerTimeoutMs: number;
  };
  /** Operator configuration, merged (defaults ← stored artifact, validated).
   *  Call-time lookup — always current after a console save. */
  config(): Record<string, unknown>;
  /** The directory this plugin's files were loaded from — the ONE asset root.
   *  Packaged plugins are a SINGLE flattened `index.js`, so a path derived
   *  from `import.meta.url` of an inner source module does not survive
   *  packaging; a plugin that ships data files (`prompts/`, `protos/`, ...)
   *  must resolve them from here (ADR-0017 §6). */
  pluginDir(): string;
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
  /**
   * Claimed SNI hosts (e.g. ['api2.cursor.sh']), or the single wildcard `'*'`
   * for a universal gateway that answers every host no exact claim took
   * (ADR-0026). The claim says only "I am willing to answer here" — `match()`
   * is the per-request ACCEPT step that narrows it to real traffic, so a
   * wildcard never captures a host wholesale.
   */
  readonly hosts: readonly string[];
  /** Per-request acceptance (host already scoped by the registry lookup). */
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
  /** Non-stream terminal (stream:false). `headers` carries wire hints the
   *  gateway should forward when its protocol has a header slot (429
   *  Retry-After / RateLimit-*); plugins may ignore it. */
  onJson(status: number, payload: unknown, headers?: Record<string, string>): void;
  /** Stream terminal (after the last onChunk). */
  onEnd(): void;
}

/**
 * Capture hooks for a gateway relay — the core access tap's three calls, so a
 * gateway streams bytes into its own feed without owning the transport (and
 * without importing a backend module at runtime).
 *
 * An ALIAS, not a copy: a second structural declaration would drift the moment
 * either side grows a member. Type-only, so nothing is imported at runtime.
 */
export type GatewayRelayTap = AccessTap;

/**
 * Host SDK for client-gateway plugins — self-contained capabilities only
 * (same rule as ModelServicePluginHost: a packaged plugin never imports
 * backend modules by path).
 */
/** Routing surface exposed to a client-gateway plugin. */
export interface GatewayCatalog {
  /** Virtual model ids in canonical order (auto/lite/plus/pro/ultra). */
  virtualModels: string[];
  /** Registered model refs (gateway-visible ids, all kinds). */
  models: { id: string; label?: string }[];
}

export interface ClientGatewayHost {
  log(...args: unknown[]): void;
  /** The live OCR home directory (bookkeeping, CA material paths). */
  ocrHome(): string;
  /** The directory this plugin's files were loaded from — the ONE asset root.
   *  A packaged plugin is a single flattened `index.js`, so resolving a data
   *  file relative to an inner source module's `import.meta.url` breaks once
   *  packaged; always resolve shipped assets from here (ADR-0017 §6). */
  pluginDir(): string;
  /** Operator configuration, merged (defaults ← stored artifact, validated).
   *  Call-time lookup — always current after a console save. */
  config(): Record<string, unknown>;
  /** Run one canonical OpenAI-shaped chat completion through the SAME
   *  dispatch pipeline as /v1/chat/completions (model resolution, tiers,
   *  breakers, captures all apply). `signal` aborts with the client. */
  chat(body: Record<string, unknown>, sink: GatewayChatSink, signal?: AbortSignal): Promise<void>;
  /** Current routing surface for AvailableModels-style fabrication. */
  catalog(): GatewayCatalog;
  /**
   * Relay a decrypted exchange upstream through the CORE transport policy:
   * `forwardProxy.rules` egress (direct / `proxy.url`) and upstream TLS trust
   * (ADR-0019), re-originating h2 faithfully with an h1 fallback. The gateway
   * owns capture via `tap`; it must never dial an origin itself.
   *
   * `h2: true` = the inbound leg is h2 (the request carries `:authority`), so
   * the h2 relay is tried first. Returns the wire that actually served it.
   *
   * `secure` = the ORIGIN scheme the caller is claiming: default `true` (TLS),
   * `false` for a plaintext origin. It changes the dial scheme and nothing
   * else — the ADR-0018 admission gate and the rule-table egress apply exactly
   * as on the TLS leg (a plaintext origin simply has no certificate to trust).
   * The h2 leg is TLS-only, so a plaintext origin is served by the h1 leg.
   *
   * `preface` = request-body bytes the plugin already consumed while deciding
   * whether to relay (model routing). They are written upstream before the
   * live stream, on both the h2 and h1 legs, so a peeked request loses nothing.
   * `ended: true` means the captured bytes are the complete body.
   *
   * `rejected: true` = the rule table's admission gate answered 403 before any
   * dial: nothing was sent upstream, the tap carries the row and `res` already
   * holds the refusal. `wire` is the leg the request arrived on.
   */
  relayUpstream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: {
      host: string;
      port: number;
      path?: string;
      h2?: boolean;
      secure?: boolean;
      tap?: GatewayRelayTap;
      preface?: { chunks: Buffer[]; ended?: boolean };
    }
  ): Promise<{ wire: 'h1' | 'h2'; rejected?: true }>;
}

/**
 * Host SDK for `client-adapter` plugins (ADR-0027).
 *
 * A client adapter is the Client Hub hook for ONE client — the thing that
 * writes a proxy env, a launcher script or a config file so a tool talks to the
 * gateway. It is self-contained runtime code plus the small facts only the host
 * knows: where OCR lives, what the LIVE forward-proxy endpoint is, and where
 * the MITM CA sits. Everything else (spawning the client's CLI, parsing its
 * output, sidecar files) the plugin does itself, which is what makes a third
 * party able to add a client without a core release.
 *
 * Deliberately NOT exposed: config mutation (find-or-mint a key instead, see
 * `apiKeys`/`createApiKey`) and the client-hook result vocabulary. A plugin
 * returns plain objects; the core's registry types them at the boundary, so a
 * plugin can never widen the contract by drifting.
 */
export interface ClientAdapterHost {
  log(...args: unknown[]): void;
  /** The live OCR home directory (sidecar/backup files belong under it). */
  ocrHome(): string;
  /** The directory this plugin was loaded from — the ONE asset root. */
  pluginDir(): string;
  /** Operator configuration, merged and validated (defaults ← stored artifact). */
  config(): Record<string, unknown>;
  /**
   * The INBOUND forward-proxy endpoint from the runtime config snapshot, or
   * `null` when `forwardProxy` is disabled. Resolved from the live snapshot,
   * never a fresh config read, so the advertised port is the one the running
   * proxy actually listens on.
   */
  forwardProxy(): { url: string; port: number; caPath: string; requireCredential: boolean } | null;
  /** The MITM CA path this install uses, resolved even when the proxy is off. */
  caCertPath(): string;
  /**
   * Is the inbound forward proxy LISTENING right now? A hook is only usable
   * while it is, and the answer is runtime state the host owns (the proxy's
   * module singleton). A packaged adapter cannot derive it from the endpoint:
   * `forwardProxy()` reports configuration, not liveness.
   */
  forwardProxyStatus(): { running: boolean; port?: number; host?: string; error?: string };
  /**
   * Is the MITM root trusted by this machine's store? `trusted: 'unknown'`
   * means the probe could not run (unsupported platform, no store access) —
   * never report that as false, a false negative sends the operator to
   * re-import a CA that is already there. Cached with a TTL; `force` bypasses
   * it, which is what a post-setup warning wants (a cached "trusted" from
   * before the import must not silence the advisory).
   */
  caTrust(caPath?: string, opts?: { force?: boolean }): Promise<{ trusted: boolean | 'unknown' }>;
  /** Common Name of the CA this install mints — the constant a truststore
   *  alias is matched against, so an adapter can recognise its own root. */
  caCommonName(): string;
  /**
   * Installed version of a client CLI, or null when the command fails/does not
   * exist. Cached for 10 minutes per command: status polling must not spawn a
   * subprocess every refresh. The adapter declares WHICH command reports the
   * version; only the probing (and the cache) is host work.
   */
  probeVersion(cmd: string[]): Promise<string | null>;
  /**
   * The VERIFIED base URL of the running gateway: candidates (sidecar record,
   * env, config) are probed with an authenticated `GET /v1/models`, so a hook
   * that must write a base URL into a client never records a stale port — an
   * agent pointed at a port nothing serves 401s on every turn.
   */
  gatewayBaseUrl(apiKey?: string): Promise<{ url: string; port: number; reachable: boolean }>;
  /**
   * The gateway API keys this install holds. A hook that must WRITE a usable
   * key into a client's own config (an IDE's ACP agent model list) has to pick
   * one, and the policy — which name is "ours", what to do when none is usable
   * — stays with the hook. The store itself is host property: a package must
   * not re-implement where keys live.
   */
  apiKeys(): { id: string; name: string; key: string; enabled?: boolean; expiresAt?: string }[];
  /** Mint a key in that same store (the `ocr` command's own mint path). Null
   *  when creation fails — the hook then reports its own advisory. */
  createApiKey(opts: { name: string; description?: string }): { key: string } | null;
}

/** Text or locale map — the same shape `description` / `warningLabels` use;
 *  `{param}` placeholders interpolate like the warning labels do. */
export type ClientTextEntry = string | Record<string, string>;

/**
 * Package-owned client presentation texts (ADR-0027). `errors` keys mirror the
 * adapter's own `ClientActionResult.reasonCode` spellings (lowerCamel or
 * snake_case, verbatim); `family` keys label the `ClientHookStatus.products`
 * rendering (product_count, ca, ca_imported, …).
 */
export interface ClientTextManifest {
  setupOk?: ClientTextEntry;
  teardownOk?: ClientTextEntry;
  hint?: ClientTextEntry;
  errors?: Record<string, ClientTextEntry>;
  family?: Record<string, ClientTextEntry>;
}

/** One plugin known to the host — loaded, or the reason it could not load. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  /** Primary part type (`types[0]`) — kept because every existing consumer
   *  reads a row as one kind; multi-part rows are described by `types`. */
  type: string;
  /** Every axis this package occupies, manifest order (ADR-0028). A console
   *  row renders one label per entry; single-part packages have exactly one. */
  types: string[];
  wires: string[];
  description?: string | Record<string, string>;
  /** This package's own advisory texts, keyed by warning code (see PluginManifest). */
  warningLabels?: Record<string, string | Record<string, string>>;
  /** Package-owned client presentation texts (see PluginManifest.clientText). */
  clientText?: ClientTextManifest;
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

export type { CallCredential };
