import { unzipSync } from 'fflate';
import { bundlePluginDir } from './pack.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getOcrHomeDir } from '../cli/paths.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../config/defaults.js';
import { getRuntimeConfigRef } from '../config/runtime.js';
import {
  emitUpstreamRequestOnce,
  emitUpstreamResponseOnce,
  emitUpstreamFailureOnce,
  withUpstreamFailureGuard,
} from '../observability/upstream-events.js';
import type {
  ClientAdapterHost,
  ClientGatewayHost,
  ClientGatewayPlugin,
  ModelServicePlugin,
  ModelServicePluginHost,
  PluginAuthType,
  PluginConfigField,
  PluginConfigSection,
  PluginEntryResult,
  PluginManifest,
  PluginProviderPreset,
  PluginView,
} from './types.js';
import type { ClientAdapter } from '../cli/clients/base.js';
import { beginPluginClientAdapterRebuild, commitPluginClientAdapterRebuild, registerPluginClientAdapter } from '../cli/clients/plugin-adapters.js';
import { commitGateways, removeGateway, retainStagedGateways, setGatewayOperatorEgress, stageGateway, getGatewayById, WILDCARD_HOST_CLAIM } from './gateways.js';
import { getGatewayChatServices } from '../surfaces/gateway-chat.js';
import { invalidatePluginConfigCache, mergedPluginConfig, pluginConfigPath, writePluginConfig } from './config.js';
import {
  assertSupportedPluginApi,
  isValidPluginId,
  normalizePluginParts,
  operatorEgressChoice,
  pluginEngineRefusal,
  validatePluginManifest,
  withGatewayEgressField,
} from './manifest.js';
import { compareVersions } from '../utils/semver.js';
import { seedBundledPlugins } from './seed.js';
import { forwardH2 } from '../forward-proxy/h2-forward.js';
import { getProxyCaller } from '../forward-proxy/caller-context.js';
import { forwardTo, proxyFail, RULE_REJECTED_MESSAGE, type ForwardTarget } from '../forward-proxy/server.js';
import { resolveUpstreamTls } from '../forward-proxy/upstream-tls.js';
import { isRuleRejected } from '../forward-proxy/egress.js';
import { claimPluginWires, isCoreWire, isPluginWire } from '../providers/plugin-wires.js';
import { currentProtocol } from '../providers/protocol.js';
import { wireFor } from '../providers/wire.js';
import { proxiedFetch, resolveProxyUrl } from '../utils/proxy.js';
/**
 * Plugin host: discovers, unpacks and loads plugins. Two types today
 * (ADR-0017): 'model-service' (outbound executors, registry below) and
 * 'client-gateway' (inbound SNI-host gateways, registered via gateways.ts).
 *
 * Discovery, in priority order. NOTHING is loaded from the checkout by default:
 * a source tree is read only when `OCR_PLUGIN_SRC_DIR` names one, so the console
 * lists what is INSTALLED rather than whatever happens to sit on disk.
 *   1. DEV  — `<OCR_PLUGIN_SRC_DIR>/<id>/plugin.json` (untracked source; opt-in)
 *   2. BUNDLED — `<ocrHome>/plugins/bundled/*.zip` (APP-OWNED packages: staged
 *      only when `OCR_BUNDLED_PLUGIN_SRC` names a package set explicitly — no
 *      release ships one, ADR-0032 — an operator install must not shadow one,
 *      and uninstall tombstones instead of deleting)
 *   3. PACK — `<ocrHome>/plugins/*.zip` (operator-installed; extracted to
 *      `<ocrHome>/plugins/unpacked/<id>/` when absent or stale, then imported)
 *
 * Packaging format: a plain zip whose ROOT holds `plugin.json` + the BUNDLED
 * entry `index.js` plus any runtime assets. The FILE NAME is free-form in
 * every root — an id always comes from the manifest, so ownership, override
 * and tombstone questions are never answered by guessing `<id>.zip`. The
 * bundle is self-contained: third-party imports are inlined at pack time,
 * because the release sidecar is a `bun build --compile` binary and compiled
 * executables cannot resolve bare specifiers from disk (no node_modules
 * lookup at runtime). Every plugin is loaded through the host SDK below, so
 * the packaged plugin never imports backend paths, and it resolves its own
 * data files through `host.pluginDir()` rather than an inner module's
 * `import.meta.url` (which the flattening invalidates).
 */

export function pluginsRoot(): string {
  const override = process.env.OCR_PLUGINS_DIR?.trim();
  if (override) return override;
  return join(getOcrHomeDir(), 'plugins');
}

/** The untracked SOURCE tree a plugin developer edits in place, or undefined
 *  (ADR-0017 §6). There is no implicit default: binding the loader to
 *  `<repo>/plugins` everywhere made a shipped/standalone gateway list plugins
 *  nobody installed, and left install/uninstall untestable behind phantom rows.
 *  `bun run dev` sets this to `plugins` for its backend child, because that is
 *  the command a plugin is being edited under; every other entry point stays
 *  clean unless the operator names a tree. */
function devSourceRoot(): string | undefined {
  const override = process.env.OCR_PLUGIN_SRC_DIR?.trim();
  return override ? resolve(override) : undefined;
}

/** The APP-OWNED package tier: packages that are never operator-owned — they
 *  win precedence over an operator install, and uninstall only writes a
 *  tombstone. Nothing a release ships is placed here (ADR-0032): the tier fills
 *  only when `seedBundledPlugins()` is pointed at an explicit package set
 *  (ADR-0029), or when an operator places one deliberately. Single definition:
 *  the loader, the ownership guards and the seeder must agree on one location. */
export function bundledPluginsDir(): string {
  return join(pluginsRoot(), 'bundled');
}

const registry = new Map<string, { plugin: ModelServicePlugin; view: PluginView }>();
/** Manifest index for the config endpoints (loaded packages only — a
 *  disabled/broken plugin has no trustworthy schema to edit against). */
const manifestsById = new Map<string, PluginManifest>();

/** Staging map for atomic rebuilds (see loadInstalledPlugins). */
const nextRegistry = new Map<string, { plugin: ModelServicePlugin; view: PluginView }>();

/** Serializes rebuilds (reload / install / enable / disable) so concurrent
 *  callers cannot interleave and leave a last-writer-wins registry. */
let rebuildInFlight: Promise<PluginView[]> = Promise.resolve([]);

/** Set by the tail of a completed `loadInstalledPlugins()`. */
let hostInitialized = false;

/** The backend capabilities handed to every model-service plugin at load time.
 *  `dir` is the plugin's load root — the only asset root a packaged plugin has.
 *
 *  Exported as a test seam: the egress seam (`fetch` / `resolveProxy`) is the
 *  ONE way a plugin reaches its upstream, and it has no other side effects —
 *  the registry-filled ``pull`` block is wired separately by
 *  ``pluginPullServices()``. */
export function buildHostSdkForTests(manifest: PluginManifest, dir: string): ModelServicePluginHost {
  return buildHostSdk(manifest, dir);
}

function buildHostSdk(manifest: PluginManifest, dir: string): ModelServicePluginHost {
  return {
    UpstreamError: UpstreamError as unknown as ModelServicePluginHost['UpstreamError'],
    upstream: {
      requestOnce: emitUpstreamRequestOnce,
      responseOnce: emitUpstreamResponseOnce,
      failureOnce: emitUpstreamFailureOnce,
      failureGuard: withUpstreamFailureGuard,
    },
    constants: { providerTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS },
    config: () => mergedPluginConfig(manifest.id, manifest.configSchema),
    ocrHome: () => getOcrHomeDir(),
    pluginDir: () => dir,
    // Egress policy is CORE-owned (ADR-0022): a plugin wire reaches its upstream
    // through this seam, never the global `fetch`, so `proxy.includes` /
    // `proxy.excludes` govern plugin traffic exactly as they govern the four
    // built-in transports. `match` carries the logical caller for the lists.
    fetch: (url, init, match) => proxiedFetch(url, init, match),
    resolveProxy: (url, match) => resolveProxyUrl(url, match),
    // Filled by pluginPullServices() BEFORE createPlugin is invoked.
    pull: {
      getProviderNode: () => undefined,
      getModelDefs: () => ({}),
      upsertModel: () => ({ success: false }),
      matchesGlob: () => false,
      expandEnvTemplate: () => undefined,
      resolveCredentialKey: () => undefined,
      catalogToDef: (m) => m,
      enrichFromCatalog: async (models) => models,
    },
  };
}

/** Fill the pull seam with the real backend services (dynamic imports). */
async function pluginPullServices(): Promise<ModelServicePluginHost['pull']> {
  const userConfig = await import('../opencode/user-config.js');
  const providerDefs = await import('../opencode/provider-defs.js');
  const autoPull = await import('../opencode/catalog/auto-pull.js');
  const credentials = await import('../opencode/credentials/index.js');
  const store = await credentials.getCredentialStore();
  return {
    getProviderNode: (id) => userConfig.getProviderNodeById(id),
    getModelDefs: (id) => userConfig.getProviderModelDefs(id) ?? {},
    upsertModel: (id, mid, def) => userConfig.upsertProviderModel(id, mid, def),
    matchesGlob: (pattern, id) => userConfig.matchesGlobPattern(pattern, id),
    expandEnvTemplate: (v) => userConfig.expandEnvTemplate(v ?? undefined),
    resolveCredentialKey: (id) => store.resolveKey(id)?.key,
    catalogToDef: (m) => providerDefs.catalogModelToDef(m),
    enrichFromCatalog: (models, excludeId) => autoPull.enrichFromCatalog(models as never[], excludeId),
  };
}

/** The capabilities handed to every `client-adapter` plugin at load time
 *  (ADR-0027). Async only because the two facts it publishes live behind the
 *  config/CA modules, which are imported lazily so the plugin host never
 *  depends on the Client Hub at module-init time. */
export async function buildClientAdapterHostSdk(
  manifest: PluginManifest,
  dir: string
): Promise<ClientAdapterHost> {
  const [
    { resolveForwardProxyEndpoint, probeClientVersion, resolveGatewayBaseUrl },
    { caCertPath, CA_CN },
    { getForwardProxyStatus },
    { probeCaTrustedCached },
    { createApiKey, listApiKeys },
  ] = await Promise.all([
    import('../cli/clients/base.js'),
    import('../forward-proxy/ca.js'),
    import('../forward-proxy/status.js'),
    import('../forward-proxy/ca-trust.js'),
    import('../auth/api-keys.js'),
  ]);
  return {
    log: (...args: unknown[]) => console.log(`[OCR] client-adapter ${manifest.id}:`, ...args),
    ocrHome: () => getOcrHomeDir(),
    pluginDir: () => dir,
    config: () => mergedPluginConfig(manifest.id, manifest.configSchema),
    forwardProxy: () => resolveForwardProxyEndpoint(),
    caCertPath: () => caCertPath(),
    forwardProxyStatus: () => getForwardProxyStatus(),
    caTrust: (caPath?: string, opts?: { force?: boolean }) =>
      probeCaTrustedCached(caPath || caCertPath(), opts).then((r) => ({ trusted: r.trusted })),
    caCommonName: () => CA_CN,
    probeVersion: (cmd: string[]) => probeClientVersion(cmd),
    gatewayBaseUrl: (apiKey?: string) => resolveGatewayBaseUrl(apiKey),
    apiKeys: () =>
      listApiKeys(false).map((k) => ({ id: k.id, name: k.name, key: k.key, enabled: k.enabled, expiresAt: k.expiresAt })),
    createApiKey: (opts) => {
      const created = createApiKey(opts);
      return created.success && created.data?.key ? { key: created.data.key } : null;
    },
  };
}

/** The capabilities handed to every client-gateway plugin at load time.
 *
 * Exported as a test seam: the relay's transport policy (ADR-0018 admission
 * gate, rule-table egress, ADR-0019 trust, h2/h1 fallback) is only reachable
 * through this factory, and it has no other side effects.
 */
export function buildGatewayHostSdk(manifest: PluginManifest, dir: string): ClientGatewayHost {
  return {
    log: (...args: unknown[]) => console.log('[OCR] gateway:', ...args),
    ocrHome: () => getOcrHomeDir(),
    config: () => mergedPluginConfig(manifest.id, manifest.configSchema),
    pluginDir: () => dir,
    chat: (body, sink, signal) => {
      const svc = getGatewayChatServices();
      if (!svc) return Promise.reject(new Error('gateway chat services not wired (forward proxy disabled?)'));
      // Identity precedence (ADR-0017): the CONNECT credential of the tunnel
      // that carried this request wins; otherwise the plugin's console-picked
      // key; with neither, gateway-chat refuses the OCR turn (401). Vendor-
      // native requests never reach this seam. Strict mode is re-read HERE,
      // not only at admission: a tunnel admitted before the operator enabled
      // `requireCredential` must not keep spending the bound key.
      const caller = getProxyCaller();
      const bound = mergedPluginConfig(manifest.id, manifest.configSchema).accountKeyId;
      const strict = getRuntimeConfigRef()?.forwardProxy?.requireCredential === true;
      const keyId = caller?.keyId ?? (strict ? '' : (typeof bound === 'string' ? bound : ''));
      return svc.run(body, sink, signal, { keyId });
    },
    catalog: () => getGatewayChatServices()?.catalog() ?? { virtualModels: [], models: [] },
    relayUpstream: async (req, res, opts) => {
      // Transport policy lives in core: the claimed host's rule-table egress
      // (`direct` / `proxy.url`) and upstream TLS trust (ADR-0019) are applied
      // by the SAME forwarders the transparent relay uses. A plugin that dials
      // an origin itself would silently bypass both.
      //
      // The ADMISSION gate runs first (ADR-0018: every proxy leg consults it
      // before opening a tunnel or minting a certificate). The egress lookup
      // cannot stand in for it — a `reject` row has no egress to honour, so the
      // forwarder would dial the host DIRECT.
      if (isRuleRejected(opts.host)) {
        opts.tap?.finish(403, undefined, 'rejected by rule');
        // The forward proxy's own refusal envelope (`proxyFail`), so a gateway
        // route and the transparent leg answer identically — the core keeps
        // ownership of its error surface.
        proxyFail(res, 403, RULE_REJECTED_MESSAGE);
        return { wire: opts.h2 ? 'h2' : 'h1', rejected: true };
      }
      const target: ForwardTarget = {
        host: opts.host,
        port: opts.port,
        path: opts.path ?? req.url ?? '/',
        // The origin scheme is the caller's claim, never a constant: a gateway
        // relaying a plaintext origin must be able to say so. Default = TLS.
        secure: opts.secure !== false,
        tap: opts.tap,
        ...(opts.preface
          ? { preface: { chunks: opts.preface.chunks, ended: opts.preface.ended === true } }
          : {}),
      };
      const upstreamTls = resolveUpstreamTls();
      if (opts.h2) {
        const relay = await forwardH2(req, res, target, upstreamTls);
        if (relay.owned) return { wire: 'h2' };
        // The h2 attempt consumed the body head synchronously; hand it to the
        // h1 leg so the fallback never truncates the request.
        target.preface = relay.preface;
      }
      await forwardTo(req, res, target, upstreamTls);
      return { wire: 'h1' };
    },
  };
}

/**
 * The capability set for a MULTI-PART package (ADR-0028). A package's
 * `createPlugin(host)` is called ONCE and must serve every part it declared,
 * so the seams are handed over as one union rather than one host per part.
 *
 * The union is safe because the seams are ADDITIVE: each part type reads a
 * different subset (`chat`/`relayUpstream` for a gateway, `forwardProxy`/
 * `caCertPath` for an adapter, `pull`/`upstream` for a model service), and no
 * seam can be used to do another part's job. The alternative — calling
 * `createPlugin` once per part — would break the one-invocation contract that
 * lets a package share state between its halves (the OpenCode ingress and its
 * gateway are configured from the same artifact).
 */
export async function buildMultiPartHostSdk(
  manifest: PluginManifest,
  dir: string
): Promise<ModelServicePluginHost & ClientGatewayHost & ClientAdapterHost> {
  const [adapterHost, pull] = await Promise.all([buildClientAdapterHostSdk(manifest, dir), pluginPullServices()]);
  return {
    ...buildHostSdk(manifest, dir),
    ...buildGatewayHostSdk(manifest, dir),
    ...adapterHost,
    pull,
    log: (...args: unknown[]) => console.log(`[OCR] plugin ${manifest.id}:`, ...args),
  };
}

/** Shape test for the three single-part return values. A package that fills one
 *  axis may return that axis' object directly (the pre-ADR-0028 contract), and
 *  every existing package does. */
function asEntryResult(raw: unknown): PluginEntryResult {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  if (typeof r.createProvider === 'function') return { provider: r as unknown as PluginEntryResult['provider'] };
  if (Array.isArray(r.hosts) && typeof r.match === 'function' && typeof r.handle === 'function') {
    return { gateway: r as unknown as PluginEntryResult['gateway'] };
  }
  if (typeof r.getStatus === 'function' && typeof r.setup === 'function' && typeof r.teardown === 'function') {
    return { clientAdapter: r as unknown as PluginEntryResult['clientAdapter'] };
  }
  return {
    provider: r.provider as PluginEntryResult['provider'],
    gateway: r.gateway as PluginEntryResult['gateway'],
    clientAdapter: r.clientAdapter as PluginEntryResult['clientAdapter'],
  };
}

function readManifest(dir: string): PluginManifest {
  const raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as unknown;
  validatePluginManifest(raw, 'invalid plugin.json');
  // The operator's outbound-leg switch is injected HERE, at the single point a
  // manifest becomes runtime data: the validator above has already refused a
  // package that declares the key itself, and every reader downstream — the
  // console drawer, the config merge, and a plugin's own `config()` closure —
  // then sees the SAME schema. Injected later, the drawer would offer a control
  // the merge drops.
  return withGatewayEgressField(raw as PluginManifest);
}

/** `readManifest`, with an unreadable/invalid manifest answered as `undefined`
 *  instead of thrown. The engine gate (ADR-0036) only needs the DECLARATION — a
 *  package whose manifest cannot be read is not a compatibility question at all,
 *  and it must keep falling through to the loader, which reports the real
 *  reason.
 */
function readManifestOrUndefined(dir: string): PluginManifest | undefined {
  try {
    return readManifest(dir);
  } catch {
    return undefined;
  }
}

/** Extract one packaged zip when the unpacked copy is missing or stale. */
function ensureUnpacked(packagedPath: string, id: string): string {
  const dest = join(pluginsRoot(), 'unpacked', id);
  const packMtime = statSync(packagedPath).mtimeMs;
  const stampPath = join(dest, '.stamp');
  if (existsSync(stampPath)) {
    try {
      if (Number(readFileSync(stampPath, 'utf8')) === packMtime) return dest;
    } catch {
      // fall through to re-extract
    }
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const files = unzipSync(new Uint8Array(readFileSync(packagedPath)));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    // zip-slip guard: an entry like `../../x` or an absolute path must never
    // escape the unpack destination
    const target = resolve(dest, name);
    if (target !== dest && !target.startsWith(dest + sep)) throw new Error(`zip entry escapes package root: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  writeFileSync(stampPath, String(packMtime));
  return dest;
}

/** True under Bun (including a `bun build --compile` binary), false under
 *  Node. Both are supported entry points (`bun run start:bun` / the desktop
 *  sidecar, and `node backend/dist/index.js` — README: Bun or Node >= 18), and
 *  they disagree about plugin import specifiers (see below). */
function isBunRuntime(): boolean {
  return (globalThis as { Bun?: unknown }).Bun !== undefined;
}

/** Import specifier for a plugin ENTRY, with an mtime cache-bust. The two
 *  runtimes need different spellings of the same specifier:
 *   - BUN keys a `file://` module on the URL ALONE and ignores the query, so
 *     `file:///…/index.js?v=2` served the already-cached v1 (observed on
 *     Windows): a reinstall that changed nothing until a restart. Bun gets a
 *     PATH instead, where the whole string (query included) is the cache key.
 *   - NODE rejects a bare Windows path outright (`Only URLs with a scheme in:
 *     file, data, and node are supported … Received protocol 'c:'`) and keys
 *     the ESM cache on the full URL (query included), so it gets a `file://`
 *     URL carrying the same query.
 *  `bun` is a parameter so both branches are unit-testable in one process. */
export function pluginEntrySpecifier(entry: string, mtimeMs: number, bun: boolean): string {
  return bun ? `${entry.replaceAll('\\', '/')}?v=${mtimeMs}` : `${pathToFileURL(entry).href}?v=${mtimeMs}`;
}

/** Import result: one field per axis the manifest declares (each present only
 *  for a part the package actually returned), plus the console row. */
async function importPlugin(
  dir: string,
  source: PluginView['source']
): Promise<{
  provider?: ModelServicePlugin;
  gateway?: ClientGatewayPlugin;
  clientAdapter?: ClientAdapter;
  view: PluginView;
}> {
  const manifest = readManifest(dir);
  assertSupportedPluginApi(manifest);
  // Dev tree is source-first; a package carries the BUNDLED entry. A package
  // without one is source-only and cannot load in a compiled sidecar, so fail
  // with the actionable fix instead of the resolver's bare-specifier error.
  const entryOrder = source === 'dev' ? (['index.ts', 'index.js'] as const) : (['index.js', 'index.ts'] as const);
  const entry = entryOrder.map((name) => join(dir, name)).find((file) => existsSync(file));
  if (!entry) throw new Error(`plugin entry missing (expected ${entryOrder.join(' or ')})`);
  if (source === 'packaged' && entry.endsWith('.ts')) {
    throw new Error('package is source-only (index.ts): packaged plugins must carry a bundled index.js — repack with `bun run plugins:build`');
  }
  // Dynamic import: plugins load from a RUNTIME registry (dev dir / packaged
  // zip), never known at author time — plus the cache-bust below.
  // cache-bust: a reinstall / dev edit reuses the same file path, so a stable
  // specifier would serve the PREVIOUS module from the ESM cache. The spelling
  // is runtime-dependent (`pluginEntrySpecifier`): Bun needs a path because it
  // ignores the query on `file://` URLs, Node needs a `file://` URL because it
  // rejects a bare Windows path.
  // The bust is the ENTRY's mtime: Bun keys static imports per resolved URL and
  // they carry no query, so an edit to an imported SUBMODULE stays cached until
  // the process restarts. A dev tree reloads on entry edits here, and on ANY
  // edit through the watcher (`bun run dev` runs the backend under `bun --watch`,
  // which restarts the process and rebuilds the module graph) — ADR-0017 §6.
  const mod = (await import(pluginEntrySpecifier(entry, statSync(entry).mtimeMs, isBunRuntime()))) as {
    createPlugin?: (
      host: ModelServicePluginHost | ClientGatewayHost | ClientAdapterHost
    ) =>
      | PluginEntryResult
      | ModelServicePlugin
      | ClientGatewayPlugin
      | ClientAdapter
      | Promise<PluginEntryResult | ModelServicePlugin | ClientGatewayPlugin | ClientAdapter>;
  };
  if (typeof mod.createPlugin !== 'function') throw new Error('plugin entry missing createPlugin(host)');
  // plugin.json IS the single manifest truth — the runtime module never
  // declares one (a TS literal would only drift from the JSON).
  // `type`/`parts` are two spellings of the same fact (ADR-0028); everything
  // downstream — the view, the registry, the lifecycle calls — reads the
  // normalized list, never the manifest field.
  const parts = normalizePluginParts(manifest);
  const gatewayPart = parts.find((p) => p.type === 'client-gateway');
  const adapterPart = parts.find((p) => p.type === 'client-adapter');
  const modelPart = parts.find((p) => p.type === 'model-service');
  const view: PluginView = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    type: parts[0]?.type ?? 'model-service',
    types: parts.map((p) => p.type),
    wires: modelPart?.wires ?? manifest.wires ?? [],
    description: manifest.description,
    warningLabels: manifest.warningLabels,
    clientText: manifest.clientText,
    changelog: manifest.changelog,
    presets: manifest.presets,
    logo: manifest.logo,
    source,
    path: dir,
    loaded: true,
  };

  // ONE createPlugin call per package, whatever its part count: a multi-part
  // package shares state between its halves, so per-part calls would give it
  // two closures over one config artifact.
  const single = parts.length === 1 ? parts[0] : undefined;
  let returned: PluginEntryResult | ModelServicePlugin | ClientGatewayPlugin | ClientAdapter;
  if (single?.type === 'client-gateway') {
    returned = (await mod.createPlugin(buildGatewayHostSdk(manifest, dir))) as ClientGatewayPlugin;
  } else if (single?.type === 'client-adapter') {
    returned = (await mod.createPlugin(await buildClientAdapterHostSdk(manifest, dir))) as ClientAdapter;
  } else if (single?.type === 'model-service') {
    returned = (await mod.createPlugin({
      ...buildHostSdk(manifest, dir),
      pull: await pluginPullServices(),
    })) as ModelServicePlugin;
  } else {
    returned = (await mod.createPlugin(await buildMultiPartHostSdk(manifest, dir))) as PluginEntryResult;
  }
  const loaded = asEntryResult(returned);

  // Every declared part must be PRESENT. A half-filled package is rejected
  // outright: registering the half that loaded would leave a console row that
  // looks installed while the other half (the reason it was installed) silently
  // answers nothing.
  if (gatewayPart) {
    const gateway = loaded.gateway;
    if (
      !gateway ||
      !Array.isArray(gateway.hosts) ||
      gateway.hosts.length === 0 ||
      typeof gateway.match !== 'function' ||
      typeof gateway.handle !== 'function'
    ) {
      throw new Error("part 'client-gateway' declared but createPlugin returned no usable gateway (need hosts[], match(), handle())");
    }
    // A wildcard answers for EVERY host, so an exact claim beside it is
    // unreachable — reject the mix here (runtime truth), not only in the
    // manifest that a package is free not to restate exactly.
    if (gateway.hosts.length > 1 && gateway.hosts.some((h) => String(h) === WILDCARD_HOST_CLAIM)) {
      throw new Error("client-gateway hosts mix '*' with exact hosts — the wildcard answers for every host, so its own claims can never be reached");
    }
  }
  if (adapterPart) {
    const adapter = loaded.clientAdapter;
    if (
      !adapter ||
      typeof adapter.name !== 'string' ||
      typeof adapter.getStatus !== 'function' ||
      typeof adapter.setup !== 'function' ||
      typeof adapter.teardown !== 'function'
    ) {
      throw new Error(
        "part 'client-adapter' declared but createPlugin returned no usable client adapter (need name, getStatus(), setup(), teardown())"
      );
    }
  }
  if (modelPart) {
    if (!loaded.provider || typeof loaded.provider.createProvider !== 'function') {
      throw new Error("part 'model-service' declared but createPlugin returned no createProvider()");
    }
  }

  // Loaded packages only — a broken plugin must not expose a schema the console
  // could edit against, so the map is filled AFTER validation. Registration is
  // also where a client-id collision with a built-in hook or another package is
  // refused: it throws, so the failure lands on THIS plugin's console row
  // instead of silently overriding a core hook.
  // The ADAPTER is registered FIRST because it is the half that can REFUSE
  // the package (a built-in/retired/duplicate client id throws). Staging the
  // gateway before it would leave a package that failed to load still owning
  // its hosts — "broken row, traffic still intercepted", the worst of both.
  if (loaded.clientAdapter) registerPluginClientAdapter(manifest.id, loaded.clientAdapter, manifest.clientRank);
  // The claim's outbound-leg tiers (ADR-0018 Revision 5) travel with the registration,
  // not with the module object: `plugin.json` is the manifest truth, the stored
  // config is the operator's word, and the gateway's own `egressFor()` is the
  // third voice the registry asks between them. An untouched switch merges back
  // as `inherit`, which is not a choice — so it never reaches the registry and
  // never silences the plugin's per-host answer.
  if (loaded.gateway) {
    stageGateway(manifest.id, loaded.gateway, {
      manifest: gatewayPart?.egress,
      operator: operatorEgressChoice(mergedPluginConfig(manifest.id, manifest.configSchema)),
    });
  }
  manifestsById.set(manifest.id, manifest);
  return { ...loaded, view };
}

function viewWireKey(view: PluginView): string {
  return view.wires[0] ?? view.id;
}

function failedView(
  id: string,
  source: PluginView['source'],
  path: string,
  err: unknown,
  declared?: PluginManifest
): PluginView {
  // The AXES still come from the manifest when it was readable: a package that
  // failed to LOAD is exactly the row an operator needs to identify, and "which
  // kinds of plugin is this" is the first thing they look for.
  const parts = declared ? normalizePluginParts(declared) : [];
  return {
    id,
    name: declared?.name ?? id,
    version: declared?.version ?? '?',
    type: parts[0]?.type ?? 'model-service',
    types: parts.map((p) => p.type),
    wires: [],
    // Identity for a row that failed to load: the console can still tell the
    // operator what the package claims to change.
    changelog: declared?.changelog,
    source,
    path,
    loaded: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * The row for a package this host REFUSES on engine-compatibility grounds
 * (ADR-0036). Distinct from `failedView` on purpose: a failed load is a BROKEN
 * package the operator can only report, while this one is a compatible-ish
 * install that is one upgrade away from working — either of the plugin or of
 * the gateway. So it renders as DISABLED (no traffic, no wire, no preset) with
 * the refusal sentence as its reason, it is not an error the console offers to
 * "fix", and it clears itself the moment the mismatch is resolved: the gate is
 * re-evaluated on every load from the manifest on disk, and nothing about this
 * state is persisted.
 *
 * The disabled LEDGER is not written: writing it would outlive the mismatch and
 * switch off a package that has become compatible.
 */
function incompatibleView(
  id: string,
  source: PluginView['source'],
  path: string,
  declared: PluginManifest,
  reason: string
): PluginView {
  const parts = normalizePluginParts(declared);
  // The manifest IS registered even though the code never loads: the console's
  // settings drawer reads the schema from `manifestsById`, and a refused row
  // whose drawer 404s looks broken rather than refused. Reading a schema runs
  // no plugin code (ADR-0036), so this costs a map entry and nothing else.
  manifestsById.set(declared.id || id, declared);
  return {
    id: declared.id || id,
    name: declared.name,
    version: declared.version,
    type: parts[0]?.type ?? 'model-service',
    types: parts.map((p) => p.type),
    // No wire: an incompatible package answers nothing, and the console's wire
    // column must not promise a protocol this host never registered.
    wires: [],
    description: declared.description,
    changelog: declared.changelog,
    presets: declared.presets,
    logo: declared.logo,
    source,
    path,
    disabled: true,
    loaded: false,
    // The console needs to tell this apart from an operator-disabled row: the
    // reason is a compatibility statement, and toggling the plugin is not the
    // remedy (upgrading one of the two sides is).
    incompatible: true,
    error: reason,
  };
}

/** Scan both discovery roots and (re)build the registry. Serialized: the
 *  swap into `registry` is atomic (built in `nextRegistry` first), so
 *  in-flight dispatch/probe never see an empty plugin set mid-rebuild. */
export async function loadInstalledPlugins(): Promise<PluginView[]> {
  const run = rebuildInFlight.then(doLoadInstalledPlugins);
  rebuildInFlight = run.catch(() => []);
  return run;
}

async function doLoadInstalledPlugins(): Promise<PluginView[]> {
  // The app-owned tier is (re)staged from an EXPLICITLY named package set before
  // discovery — tests, or a downstream build that deliberately ships packages.
  // On a normal install there is no source and this is a no-op (ADR-0032).
  // Idempotent (byte compare) and disabled under a dev tree, where the source
  // being edited must win.
  const seeded = seedBundledPlugins(bundledPluginsDir());
  if (seeded.seeded.length > 0) {
    console.log(`[OCR] Plugins: seeded bundled packages: ${seeded.seeded.join(', ')} (from ${seeded.source})`);
  }
  nextRegistry.clear();
  manifestsById.clear();
  // Plugin-contributed client adapters are rebuilt with everything else, but
  // TRANSACTIONALLY: registrations below land in a staging map and only the
  // commit at the tail swaps them in, so a scan that throws keeps the previous
  // adapter set live instead of leaving the Client Hub blind (ADR-0027). Core
  // adapters live in the other registry and are never touched.
  beginPluginClientAdapterRebuild();
  invalidatePluginConfigCache();
  const views: PluginView[] = [];
  // Rows refused by the engine gate (ADR-0036). Kept in their own list because
  // they are part of THIS load's view set (the console lists them, and they
  // claim their id) but they are not "installed" in the disabled ledger.
  const incompatibleViews: PluginView[] = [];
  const devRoot = devSourceRoot();
  const disabled = readDisabled();
  disabledViews = [];
  const seenIds = new Set<string>();

  if (devRoot && existsSync(devRoot)) {
    for (const name of readdirSync(devRoot)) {
      const dir = join(devRoot, name);
      if (!existsSync(join(dir, 'plugin.json'))) continue;
      // ENGINE-COMPATIBILITY gate (ADR-0036) FIRST — ahead of the disabled
      // check AND ahead of the import: code that cannot run here is never
      // imported, so a mismatch costs one manifest read instead of a thrown
      // module, and a package that is both incompatibly old and operator-
      // disabled reports the reason that toggling cannot fix (the remedy is an
      // upgrade, not a switch). The READABLE manifest is what makes the
      // refusal actionable, so an unreadable one falls through to
      // `importPlugin` / `failedView` and gets the failure wording instead.
      const devDeclared = readManifestOrUndefined(dir);
      const devRefusal = devDeclared ? pluginEngineRefusal(devDeclared) : undefined;
      if (devDeclared && devRefusal) {
        seenIds.add(name);
        incompatibleViews.push(incompatibleView(name, 'dev', dir, devDeclared, devRefusal));
        continue;
      }
      if (disabled.has(name)) {
        seenIds.add(name);
        disabledViews.push(stubDisabledView(name, dir, 'dev'));
        continue; // disabled: listed, never imported or registered
      }
      seenIds.add(name);
      try {
        const loaded = await importPlugin(dir, 'dev');
        loaded.view.loadedAt = Date.now();
        // The gateway is staged inside importPlugin (after the adapter half
        // registered); only the model-service registry is committed here.
        if (loaded.provider) nextRegistry.set(viewWireKey(loaded.view), { plugin: loaded.provider, view: loaded.view });
        views.push(loaded.view);
      } catch (err) {
        let declared: PluginManifest | undefined;
        try {
          declared = readManifest(dir);
        } catch {
          // unreadable manifest: the id-only row is the honest view
        }
        views.push(failedView(name, 'dev', dir, err, declared));
      }
    }
  }

  const packRoot = pluginsRoot();
  // Deterministic precedence: app-owned packages (`bundled/`) win over
  // operator-installed ones, and file names sort inside each root. Dev tree
  // already won above. An id must never depend on readdir order.
  for (const root of [
    { dir: bundledPluginsDir(), bundled: true },
    { dir: packRoot, bundled: false },
  ]) {
    if (!existsSync(root.dir)) continue;
    const packages = readdirSync(root.dir)
      .filter((name) => /\.zip$/i.test(name))
      .sort();
    for (const name of packages) {
      const packagedPath = join(root.dir, name);
      // The id lives in the manifest, not the file name (which is free-form).
      // A zip whose manifest is unreadable/invalid falls back to the file-name
      // stem so the failure still surfaces as a visible view instead of being
      // skipped — but ONLY when that stem is itself a slug: the id becomes a
      // path component (`ensureUnpacked` deletes `<root>/unpacked/<id>`
      // recursively), so a file named `...zip` (stem `..`) would otherwise
      // have the unpacker delete the entire plugins root.
      const packagedManifest = readPackagedManifest(packagedPath);
      const stem = name.replace(/\.zip$/i, '');
      const id = packagedManifest?.id ?? (isValidPluginId(stem) ? stem : undefined);
      if (!id) {
        console.warn(`[OCR] plugins: ${packagedPath} has no readable manifest and its file name is not a plugin id — ignored`);
        continue;
      }
      if (!root.bundled && id.startsWith('ocr-')) {
        // `ocr-*` belongs to app-owned packages; an operator install must not
        // claim it (and an upgrade must stay predictable).
        views.push(
          failedView(id, 'packaged', packagedPath, new Error("plugin id 'ocr-*' is reserved for app-owned packages"))
        );
        seenIds.add(id);
        continue;
      }
      if (seenIds.has(id)) {
        console.warn(`[OCR] plugins: duplicate id '${id}' — ${packagedPath} ignored (a higher-precedence copy already loaded)`);
        continue;
      }
      // ENGINE-COMPATIBILITY gate (ADR-0036) FIRST — ahead of the disabled
      // check and before `ensureUnpacked`: an unloadable package must not
      // leave an extracted tree behind, its code must never reach the module
      // cache, and a package that is both incompatibly old and operator-
      // disabled must report the reason a switch cannot fix. The package FILE
      // stays — an upgrade is installed over it, and the gate re-runs on every
      // load.
      if (packagedManifest) {
        const refusal = pluginEngineRefusal(packagedManifest);
        if (refusal) {
          seenIds.add(id);
          incompatibleViews.push(incompatibleView(id, 'packaged', packagedPath, packagedManifest, refusal));
          continue;
        }
      }
      if (disabled.has(id)) {
        // No ensureUnpacked for disabled packages: their code stays dormant.
        disabledViews.push(stubDisabledView(id, join(packRoot, 'unpacked', id), 'packaged', packagedManifest));
        seenIds.add(id);
        continue;
      }
      try {
        const dir = ensureUnpacked(packagedPath, id);
        const loaded = await importPlugin(dir, 'packaged');
        loaded.view.loadedAt = Date.now();
        if (loaded.provider) nextRegistry.set(viewWireKey(loaded.view), { plugin: loaded.provider, view: loaded.view });
        seenIds.add(id);
        views.push(loaded.view);
      } catch (err) {
        // Claim the id even when the load FAILS: a broken higher-precedence
        // copy must not let a lower-precedence package of the same id load
        // beside it (two console rows, ambiguous disable/uninstall).
        seenIds.add(id);
        views.push(failedView(id, 'packaged', packagedPath, err, packagedManifest));
      }
    }
  }
  // A gateway is committed ONLY for a package that produced a LOADED row.
  // Anything else staged is a half-registration from a load that threw after
  // staging (or a future path that forgets to unstage) — a gateway that
  // answers with no row to disable is unreachable state, so it is dropped.
  // Engine-refused rows join the view set HERE, after every other gate has run,
  // so they can never shadow a same-id package that does load.
  retainStagedGateways(new Set(views.filter((v) => v.loaded).map((v) => v.id)));
  // `views` is the LIVE load result (which package owns an id, what loaded);
  // `lastViews` is what the console lists, and a package refused by the engine
  // gate is exactly a row the operator has to SEE — it is silently dead
  // otherwise, with no clue that an upgrade would fix it.
  lastViews = [...views, ...incompatibleViews];
  for (const view of incompatibleViews) console.warn(`[OCR] plugins: ${view.error}`);
  // Atomic swap: in-flight dispatch/probe never observe an empty registry —
  // and the gateway registry rides the same commit point.
  registry.clear();
  for (const [k, v] of nextRegistry) registry.set(k, v);
  nextRegistry.clear();
  // The wire vocabulary follows the same commit point: the protocol decision
  // points (`wireFor`, the dispatch tables, the console vocabulary) read this
  // set instead of enumerating vendor protocols, so a loaded/removed plugin
  // adds/removes its wires atomically with the registry swap.
  claimPluginWires([...registry.values()].flatMap((entry) => entry.view.wires));
  commitGateways();
  commitPluginClientAdapterRebuild();
  hostInitialized = true;
  return views;
}

/** True once a full load has completed in this process. Callers that may run
 *  BEFORE the boot load (the standalone `ocr` CLI, which never boots the
 *  server) use it to avoid a redundant rebuild on every Client Hub request. */
export function isPluginHostInitialized(): boolean {
  return hostInitialized;
}

/** Disabled plugin ids — an operator-maintained list beside the packages
 *  (the config.yaml schema is versioned and frozen per ADR-0016; plugin
 *  lifecycle state lives with the plugin artifacts, like registrations.json).
 *  A disabled plugin is discovered and LISTED but its code is never imported
 *  and its wire is never registered — the reversible "temporary uninstall". */
function disabledPath(): string {
  return join(pluginsRoot(), 'disabled.json');
}

function readDisabled(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(disabledPath(), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeDisabled(ids: Iterable<string>): void {
  const list = [...ids];
  // Empty bookkeeping is NO bookkeeping: removing the last entry must not leave
  // a `[]` file behind (same rule as writeRegistrations).
  if (list.length === 0) {
    rmSync(disabledPath(), { force: true });
    return;
  }
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(disabledPath(), JSON.stringify(list, null, 2));
}

/** Stub views for disabled plugins: manifest facts from plugin.json when
 *  readable (code is NOT imported), a bare id row otherwise. */
let disabledViews: PluginView[] = [];
/** Every view (both plugin types, failures included) from the last full
 *  load — the console listing derives from this, NOT from the model-service
 *  registry, so gateways and boot-time failures stay visible (ADR-0017). */
let lastViews: PluginView[] = [];

/** Facts for a disabled plugin, WITHOUT importing its code: the manifest from
 *  the load dir when it was unpacked, else straight out of the package zip (a
 *  tombstoned app-owned package may never have been extracted), else a bare id
 *  row. */
function stubDisabledView(
  id: string,
  dir: string,
  source: PluginView['source'],
  packaged?: PluginManifest
): PluginView {
  try {
    const m = packaged ?? readManifest(dir);
    const parts = normalizePluginParts(m);
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      type: parts[0]?.type ?? 'model-service',
      types: parts.map((p) => p.type),
      // `wires` stays EMPTY on a dormant row, exactly like a refused one: the
      // package answers no protocol here (its code is never imported), so the
      // console's wire column must not promise one. The manifest still declares
      // them — that is a fact about the package, not about this host.
      wires: [],
      description: m.description,
      changelog: m.changelog,
      presets: m.presets,
      logo: m.logo,
      source,
      path: dir,
      disabled: true,
      loaded: false,
    };
  } catch {
    return {
      id,
      name: id,
      version: '?',
      type: 'model-service',
      types: [],
      wires: [],
      source,
      path: dir,
      disabled: true,
      loaded: false,
    };
  }
}

/** Disable or re-enable a plugin by id. Disabling also removes the provider
 *  defs it auto-registered (the same hot-unplug half as uninstall) so its
 *  presets leave the routing surface; enabling + reload re-registers them.
 *  The caller reloads. */
export async function setPluginDisabled(id: string, disabled: boolean): Promise<{ providersRemoved: string[] }> {
  if (!isValidPluginId(id)) throw new Error('invalid plugin id');
  const set = readDisabled();
  if (disabled === set.has(id)) return { providersRemoved: [] };
  if (disabled) {
    set.add(id);
    writeDisabled(set);
    removeGateway(id); // a disabled gateway stops answering before the reload lands
    return { providersRemoved: await removePluginRegistrations(id) };
  }
  set.delete(id);
  writeDisabled(set);
  return { providersRemoved: [] };
}

/** Executor lookup for one wire — the dispatch layer's only entry point. */
export function getModelServicePluginEntry(wire: string): { plugin: ModelServicePlugin; view: PluginView } | undefined {
  if (isCoreWire(wire)) return undefined;
  for (const entry of registry.values()) {
    if (entry.view.wires.includes(wire)) return entry;
  }
  return undefined;
}

export function getModelServicePlugin(wire: string): ModelServicePlugin | undefined {
  return getModelServicePluginEntry(wire)?.plugin;
}

/** True when the declared methods are only `none` (no key, no web login).
 *  Absent stays the legacy key form. */
export function pluginDeclinesCredentials(plugin: { authTypes?: readonly PluginAuthType[] } | undefined): boolean {
  const types = plugin?.authTypes;
  return Array.isArray(types) && types.includes('none') && !types.some((t) => t === 'key' || t === 'webLogin');
}

/** True when `providerId` is a preset of a plugin that owns its own login. */
export function providerDeclinesCredentials(providerId: string): boolean {
  for (const { plugin, view } of registry.values()) {
    if ((view.presets ?? []).some((preset) => preset.providerId === providerId)) {
      return pluginDeclinesCredentials(plugin);
    }
  }
  return false;
}

/** Manifest id of an uploaded package, read WITHOUT touching disk. The install
 *  route needs it up front to snapshot the version it is about to replace, so a
 *  failed upgrade can be rolled back instead of deleting a working install. */
export function packageIdOf(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('not a valid zip package');
  }
  const manifestRaw = files['plugin.json'];
  if (!manifestRaw) throw new Error('package root lacks plugin.json');
  return readManifestFromBytes(manifestRaw).id;
}

/**
 * Install an uploaded package: validate the zip carries a valid plugin.json,
 * then store it canonically as `<manifest-id>.zip` — the uploaded file name is
 * free-form and never becomes the id.
 *
 * UPGRADE is the same call with a higher `version`: the package is replaced,
 * the operator's settings artifact (`plugins/config/<id>.json`) is left alone,
 * and the unpacked tree is re-extracted because `ensureUnpacked` keys on the
 * package mtime. DOWNGRADE is refused unless the caller says it is a rollback
 * (`allowDowngrade`) — replacing a newer install with an older one is either a
 * mistake or a deliberate rollback, and the console's upload button cannot tell
 * the two apart. "Uninstall first" is the explicit path.
 *
 * Returns the id plus the version it replaced, so the route can report what it
 * actually did.
 */
export function installPluginPackage(
  bytes: Uint8Array,
  opts: { allowDowngrade?: boolean } = {}
): { id: string; version: string; replacedVersion?: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('not a valid zip package');
  }
  const manifestRaw = files['plugin.json'];
  if (!manifestRaw) throw new Error('package root lacks plugin.json');
  let manifest: PluginManifest;
  try {
    manifest = readManifestFromBytes(manifestRaw);
  } catch (err) {
    // The validator already prefixes "invalid plugin.json"; re-prefixing here
    // produced "invalid plugin.json: invalid plugin.json: ..." in the console.
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  assertSupportedPluginApi(manifest);
  // Ownership refusals come FIRST: a rejected install must not touch a single
  // plugin artifact. (Clearing the disabled ledger before this point used to
  // resurrect a tombstoned app-owned package on the next reload.) Both answers
  // come from the MANIFEST id — file names in `bundled/` are free-form.
  if (bundledPackagePath(manifest.id)) {
    throw new Error(`'${manifest.id}' is an app-owned package (plugins/bundled) — disable it from the plugins page instead of installing an override`);
  }
  if (manifest.id.startsWith('ocr-')) {
    throw new Error(`plugin id 'ocr-*' is reserved for app-owned packages`);
  }
  // Version gate BEFORE anything lands on disk. A same-version upload is a
  // rebuild (allowed — that is how a broken build gets replaced), a higher one
  // is an upgrade, a lower one is refused so a stale download cannot silently
  // roll a fixed install back.
  let replacedVersion: string | undefined;
  const existingManifest = (() => {
    const packaged = packagePathIn(pluginsRoot(), manifest.id);
    return packaged ? readPackagedManifest(packaged) : undefined;
  })();
  if (existingManifest) {
    replacedVersion = existingManifest.version;
    if (!opts.allowDowngrade && compareVersions(manifest.version, existingManifest.version) < 0) {
      throw new Error(
        `'${manifest.id}' ${manifest.version} is OLDER than the installed ${existingManifest.version} — uninstall it first if a downgrade is really intended`
      );
    }
  }
  mkdirSync(pluginsRoot(), { recursive: true });
  // The id is a validated slug (manifest.ts), so it is safe as a path
  // component here and in every other lifecycle path below.
  const dest = join(pluginsRoot(), `${manifest.id}.zip`);
  writeFileSync(dest, bytes);
  // A leftover package for this id under a FREE-FORM name (a hand-placed older
  // copy) would win discovery by file-name sort and shadow the copy just
  // written — the install owns the id, so every other copy of it goes.
  for (const stale of packagePathsIn(pluginsRoot(), manifest.id)) {
    if (stale !== dest) rmSync(stale, { force: true });
  }
  // a stale unpacked copy must not shadow the new package
  rmSync(join(pluginsRoot(), 'unpacked', manifest.id), { recursive: true, force: true });
  // Installing expresses intent to USE the plugin: a stale disabled entry must
  // not make every reinstall fail. Cleared only AFTER the bytes are on disk —
  // a failed write must not leave the plugin enabled-but-absent.
  const disabled = readDisabled();
  if (disabled.delete(manifest.id)) writeDisabled(disabled);
  return { id: manifest.id, version: manifest.version, replacedVersion };
}

function readManifestFromBytes(raw: Uint8Array): PluginManifest {
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  validatePluginManifest(parsed, 'invalid plugin.json');
  return parsed as PluginManifest;
}

/** Read a packaged zip's manifest WITHOUT extracting or importing anything.
 *  Returns undefined when the zip or its manifest is unreadable/invalid. */
function readPackagedManifest(packagedPath: string): PluginManifest | undefined {
  try {
    const raw = unzipSync(new Uint8Array(readFileSync(packagedPath)))['plugin.json'];
    return raw ? readManifestFromBytes(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** The APP-OWNED package for `id`, if any. File names inside a discovery
 *  root are FREE-FORM (the id lives in the manifest), so every ownership
 *  question — "is this package app-owned?", "is this install an override?",
 *  "is this uninstall a tombstone?" — is answered by scanning `bundled/` for
 *  the manifest id, never by guessing `${id}.zip`. */
function bundledPackagePath(id: string): string | undefined {
  return packagePathIn(bundledPluginsDir(), id);
}

/** Every package file inside ONE discovery root that CLAIMS `id`. Names are
 *  free-form (the id lives in the manifest); a corrupt zip still matches by its
 *  file-name stem, which is how a broken package got surfaced. Plural because
 *  the same id can legitimately appear more than once on disk — install and
 *  uninstall must account for every copy, never just the first one found. */
function packagePathsIn(root: string, id: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!/\.zip$/i.test(name)) continue;
    const file = join(root, name);
    if ((readPackagedManifest(file)?.id ?? name.replace(/\.zip$/i, '')) === id) found.push(file);
  }
  return found;
}

/** The ONE package file inside `root` that claims `id` (first by file name). */
function packagePathIn(root: string, id: string): string | undefined {
  return packagePathsIn(root, id)[0];
}

/** Remove a plugin's package files only (no preset bookkeeping) — used by the
 *  install route when the uploaded package fails to load, so a broken package
 *  does not re-fail every boot. */
export function discardPluginPackage(id: string): void {
  if (!isValidPluginId(id)) return;
  const root = pluginsRoot();
  rmSync(join(root, `${id}.zip`), { force: true });
  rmSync(join(root, 'unpacked', id), { recursive: true, force: true });
}

/** Uninstall a plugin: remove its packaged zip, unpacked copy, registered
 *  preset providers and the operator's settings artifact, then the caller
 *  reloads — the plugin leaves NOTHING behind (a shipped package is the one
 *  exception: it is tombstoned, because the app owns the file). Dev-tree
 *  plugins are OWNED by the operator's checkout — refuse and say so instead of
 *  deleting source files. */
export async function uninstallPlugin(
  id: string
): Promise<{ removed: string[]; providersRemoved: string[]; devOnly?: boolean }> {
  if (!isValidPluginId(id)) throw new Error('invalid plugin id');
  const removed: string[] = [];
  const packRoot = pluginsRoot();
  // Packages shipped WITH the app are not operator-owned files: uninstall is a
  // TOMBSTONE in the disabled ledger, so an upgrade that re-seeds the same
  // package does not silently bring it back. That IS `setPluginDisabled(id,
  // true)` — delegate, so a tombstone and a disable can never drift apart.
  if (bundledPackagePath(id)) {
    const { providersRemoved } = await setPluginDisabled(id, true);
    return { removed: [], providersRemoved };
  }
  // Free-form names, same as discovery: every package that CLAIMS the id is
  // operator state, so all of them go — not just the first one found.
  for (const packaged of packagePathsIn(packRoot, id)) {
    rmSync(packaged, { force: true });
    removed.push(packaged);
  }
  const unpacked = join(packRoot, 'unpacked', id);
  if (existsSync(unpacked)) {
    rmSync(unpacked, { recursive: true, force: true });
    removed.push(unpacked);
    // The container is host scratch space, not operator state: drop it once the
    // last unpacked copy is gone (it is recreated on the next install).
    try {
      if (readdirSync(join(packRoot, 'unpacked')).length === 0) rmSync(join(packRoot, 'unpacked'), { recursive: true, force: true });
    } catch {
      // absent — nothing to prune
    }
  }
  const providersRemoved = await removePluginRegistrations(id);
  // Operator settings are plugin state too: uninstall means GONE, so a later
  // install starts from the manifest defaults. An UPGRADE is a plain install
  // OVER the existing id (it keeps the config artifact untouched), which is
  // exactly why uninstall does not need to preserve anything.
  const configFile = pluginConfigPath(id);
  if (existsSync(configFile)) {
    rmSync(configFile, { force: true });
    removed.push(configFile);
    const configDir = dirname(configFile);
    // Leave no empty `plugins/config/` behind either.
    try {
      if (readdirSync(configDir).length === 0) rmSync(configDir, { recursive: true, force: true });
    } catch {
      // absent or unreadable — nothing to prune
    }
  }
  invalidatePluginConfigCache(id);
  removeGateway(id); // stop answering immediately; the caller's reload commits the full rebuild
  // An uninstalled plugin must not linger as a disabled stub row.
  const disabled = readDisabled();
  if (disabled.delete(id)) writeDisabled(disabled);
  if (removed.length === 0) {
    // Dev-tree plugin: its source directory is operator-owned, but any preset
    // providers it had registered are cleanly unregistered.
    if (providersRemoved.length > 0) return { removed, providersRemoved, devOnly: true };
    // A row the host is CURRENTLY SHOWING that owns no artifact on disk: its
    // package was removed out from under us (an operator cleanup of
    // `plugins/`, a package the install route already discarded on load
    // failure). DELETE stays idempotent there — nothing to remove, and the
    // caller's reload is what drops the row — instead of claiming the id is
    // unknown while the operator is looking at it. Only an id the host has
    // NEVER seen is a real error: a typo, or a dev-tree plugin whose source
    // directory the operator owns and must delete themselves.
    const shown = lastViews.find((v) => v.id === id);
    if (shown && shown.source !== 'dev') return { removed, providersRemoved };
    throw new Error(
      `no installed package for '${id}' — unknown id, or a dev-tree plugin (delete its directory to remove it)`
    );
  }
  return { removed, providersRemoved };
}

/** Hot-plug preset bookkeeping: installing/reloading a plugin REGISTERS every
 *  preset the plugin declares that is not already defined (existing operator
 *  defs are never overwritten); uninstalling REMOVES exactly the providers
 *  this plugin registered — and only while they still look exactly as the
 *  plugin wrote them. The ledger lives beside the packages so a packaged
 *  install and its cleanup travel together.
 *
 *  `written` is what makes that distinction possible: a def the plugin created
 *  always carries a `name`/`settings` of its own, so a "is this node still
 *  non-empty?" heuristic (the legacy rule) cannot tell its OWN fields from an
 *  operator edit and therefore never deletes anything. The recorded snapshot
 *  answers the real question: has this def DRIFTED since we wrote it? */
interface RegistrationEntry {
  providers: string[];
  /** providerId → the def node this plugin wrote, for the drift comparison. */
  written?: Record<string, unknown>;
  /** provider ids the OPERATOR deleted. Preset registration must not recreate
   *  them (a reload/install of ANY plugin re-runs it for every plugin), and a
   *  def that reappears clears its own tombstone — that is connect intent.
   *  The tombstone lives with this plugin's ledger, so uninstalling the OWNING
   *  plugin forgets it (a fresh install registers fresh presets). */
  deleted?: string[];
}

function registrationsPath(): string {
  return join(pluginsRoot(), 'registrations.json');
}

/** Reads BOTH shapes: a legacy `string[]` (ledger from before snapshots were
 *  recorded) and the current `{ providers, written }`. A legacy entry has no
 *  snapshot, so uninstall falls back to the old heuristic for it. */
function readRegistrations(): Record<string, RegistrationEntry> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(registrationsPath(), 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, RegistrationEntry> = {};
  for (const [pluginId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[pluginId] = { providers: value.filter((v): v is string => typeof v === 'string') };
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const entry = value as { providers?: unknown; written?: unknown; deleted?: unknown };
    out[pluginId] = {
      providers: Array.isArray(entry.providers) ? entry.providers.filter((v): v is string => typeof v === 'string') : [],
      ...(entry.written && typeof entry.written === 'object' && !Array.isArray(entry.written)
        ? { written: entry.written as Record<string, unknown> }
        : {}),
      ...(Array.isArray(entry.deleted)
        ? { deleted: entry.deleted.filter((v): v is string => typeof v === 'string') }
        : {}),
    };
  }
  return out;
}

function writeRegistrations(map: Record<string, RegistrationEntry>): void {
  // Same rule: a `{}` receipt nobody needs. Not writing it keeps a plugin-less
  // boot and a clean uninstall from creating scratch files.
  if (Object.keys(map).length === 0) {
    rmSync(registrationsPath(), { force: true });
    return;
  }
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(registrationsPath(), JSON.stringify(map, null, 2));
}

/** Inverted preset ledger: providerId → owning plugin id. Read-only projection
 *  for console catalog tagging/filtering — providers.json itself stays
 *  unmarked (ADR-0010: the ledger, not the defs file, is the provenance truth). */
export function pluginProviderOrigins(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pluginId, entry] of Object.entries(readRegistrations())) {
    for (const id of entry.providers) out[id] = pluginId;
  }
  // A deleted preset leaves the ledger, but the connect catalog still lists it.
  // Keep the plugin id on that row so the origin filter can find it. Only a
  // package still on disk may claim an origin: uninstall drops the ledger and
  // artifacts at once while the registry keeps the last views until the
  // caller's reload, so projecting from the registry alone would tag rows with
  // a plugin the operator already removed.
  for (const { view } of registry.values()) {
    if (!packageStillInstalled(view)) continue;
    for (const preset of view.presets ?? []) {
      if (!out[preset.providerId]) out[preset.providerId] = view.id;
    }
  }
  return out;
}

/** Disk truth behind a plugin view: a dev-tree package is operator-owned and
 *  always "installed"; a packaged one counts only while a package artifact or
 *  its unpacked tree is still present. */
function packageStillInstalled(view: PluginView): boolean {
  if (view.source === 'dev') return true;
  if (bundledPackagePath(view.id)) return true;
  if (packagePathsIn(pluginsRoot(), view.id).length > 0) return true;
  return existsSync(join(pluginsRoot(), 'unpacked', view.id));
}

/** Forget ONE provider id in every preset ledger entry and tombstone it. Called
 *  when the operator DELETES a provider: that is intent, so a later boot/reload
 *  (any plugin's install re-runs registration for ALL plugins) must not
 *  resurrect the preset's def. Clearing the tombstone is an explicit connect —
 *  see `ensurePresetProvider`. A credential still in the store keeps the
 *  provider alive through the boot bind sweep — that is credential truth;
 *  disconnecting is the purge path, not the delete path. */
export function forgetProviderRegistration(providerId: string): void {
  const ledger = readRegistrations();
  let changed = false;
  for (const [id, entry] of Object.entries(ledger)) {
    if (!entry.providers.includes(providerId) && !entry.written?.[providerId]) continue;
    const providers = entry.providers.filter((p) => p !== providerId);
    const written = entry.written ? { ...entry.written } : undefined;
    if (written) delete written[providerId];
    const deleted = [...new Set([...(entry.deleted ?? []), providerId])];
    ledger[id] = {
      providers,
      ...(written && Object.keys(written).length > 0 ? { written } : {}),
      deleted,
    };
    changed = true;
  }
  if (changed) writeRegistrations(ledger);
}

/** Lift every deletion tombstone for one provider id (explicit connect intent). */
function clearProviderDeletion(providerId: string): void {
  const ledger = readRegistrations();
  let changed = false;
  for (const [id, entry] of Object.entries(ledger)) {
    if (!entry.deleted?.includes(providerId)) continue;
    const deleted = entry.deleted.filter((p) => p !== providerId);
    if (entry.providers.length === 0 && Object.keys(entry.written ?? {}).length === 0 && deleted.length === 0) {
      delete ledger[id];
    } else {
      ledger[id] = {
        providers: entry.providers,
        ...(entry.written && Object.keys(entry.written).length > 0 ? { written: entry.written } : {}),
        ...(deleted.length > 0 ? { deleted } : {}),
      };
    }
    changed = true;
  }
  if (changed) writeRegistrations(ledger);
}

/** True when the def currently on disk is byte-for-byte what the plugin wrote
 *  (no operator edit since). `snapshot === undefined` means the ledger predates
 *  snapshots, so the caller falls back to the heuristic below. */
function matchesRegistration(snapshot: unknown, current: unknown): boolean {
  return snapshot !== undefined && JSON.stringify(snapshot) === JSON.stringify(current);
}

/** A MEANINGFUL def is operator-owned and never overwritten/deleted, and
 *  joins the ledger (provenance tag/filter). A bare stub (New-custom leftover:
 *  only a protocol-slot field) is left un-ledgered so uninstall never deletes
 *  an operator file node the plugin never created; an existing node is NEVER
 *  taken over by a preset (syncPluginPresets skips every id already present).
 *  Reads the RAW defs-file node:
 *  getProviderNodeById returns a normalized view that derives protocols/options
 *  from settings, which would make even a bare stub look meaningful. */
function isMeaningfulDef(raw: Record<string, unknown> | undefined): boolean {
  return Boolean(
    raw &&
      Object.entries(raw).some(([key, value]) => {
        if (key === 'package' || key === 'protocols') return false; // a New-custom stub is ONLY a protocol-slot field
        if (key === 'models') return Boolean(value && typeof value === 'object' && Object.keys(value as object).length > 0);
        return value !== undefined && value !== null && value !== '' && !(typeof value === 'object' && Object.keys(value as object).length === 0);
      })
  );
}

/** The wire a RAW defs-file node currently resolves to — the same precedence
 *  the console probe and the web-login resolver use (`wireFor(npm)` first,
 *  baseURL fingerprint only when no package is declared). */
function defWireOf(raw: Record<string, unknown>): string {
  const protocols = Array.isArray(raw.protocols) ? raw.protocols.filter((x): x is string => typeof x === 'string') : [];
  const pkg = protocols[0] ?? (typeof raw.package === 'string' ? raw.package : typeof raw.npm === 'string' ? raw.npm : '');
  if (pkg) return wireFor(pkg);
  const settings = raw.settings && typeof raw.settings === 'object' ? (raw.settings as Record<string, unknown>) : {};
  const options = raw.options && typeof raw.options === 'object' ? (raw.options as Record<string, unknown>) : {};
  const base = (settings.baseURL ?? options.baseURL ?? raw.baseURL ?? '') as string;
  return base ? wireFor(undefined, base) : 'unroutable';
}

/** A preset def that exists but can never reach ANY executor: the current
 *  spelling resolves to `unroutable` (wireFor refuses it rather than guessing —
 *  e.g. an older plugin generation's `@opencode/ai/providers/<vendor>`). That
 *  is unreachable state, not operator intent, so the preset's declared wire
 *  wins. A def on a routable wire is left alone (an operator may deliberately
 *  point the preset id at a compatible endpoint), and a retired NODE shape
 *  belongs to the defs import, not here. */
function presetWireIsBroken(raw: Record<string, unknown>): boolean {
  if (raw.npm !== undefined || raw.options !== undefined) return false; // v1 node shape: the import owns it
  return defWireOf(raw) === 'unroutable';
}

/** Rewrite ONLY the routing slot of a broken preset def. Every other slot the
 *  operator owns (name, baseURL/settings, headers, env, body, models) rides
 *  through untouched — the def could not have routed anywhere before, so no
 *  working configuration is lost. */
function repairPresetWire(raw: Record<string, unknown>, presetWire: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw, protocols: [presetWire] };
  delete next.npm;
  delete next.package;
  delete next.protocol;
  return next;
}

/** Def name a preset registers: the manifest's `displayName` (plain string) or
 *  its en-US entry, first-locale as the last resort. ONE spelling for every
 *  writer of a preset def (sync, ensure-on-connect). */
function presetDefName(preset: PluginProviderPreset): string {
  const dn = preset.displayName;
  return typeof dn === 'string' ? dn : (dn['en-US'] ?? Object.values(dn)[0] ?? preset.providerId);
}

/** Register every not-yet-defined preset of every loaded plugin, and RETIRE the
 *  ones the plugin no longer declares. A preset is skipped whenever the defs
 *  file already holds a MEANINGFUL node with that id, so presets never take
 *  over operator file state; a bare protocol-only stub (the New-custom form or
 *  the boot bind sweep's node — machine-written, no operator content) is fair
 *  game and the preset overwrites it. The ONE exception is an unroutable wire
 *  spelling (an older plugin generation's SDK package, e.g.
 *  `@opencode/ai/providers/<vendor>`): that def can never execute, so the
 *  preset rewrites the routing slot alone and keeps the rest — otherwise a
 *  reload would report success while the provider stays dead
 *  (`provider '…' is not on a plugin wire with a web-login capability`).
 *  Retirement uses the same drift rule as uninstall: a def still identical to
 *  what the plugin wrote is ours to delete; one the operator edited stays, it
 *  just stops being claimed.
 *  Returns the provider ids registered or wire-repaired (boot/reload logging). */
export async function syncPluginPresets(): Promise<string[]> {
  const { upsertProviderDef, deleteProviderDef } = await import('../opencode/user-config.js');
  const { readProviderDefsFile, writeProviderDefs } = await import('../opencode/provider-defs.js');
  const created: string[] = [];
  const ledger = readRegistrations();
  for (const { view } of registry.values()) {
    const entry: RegistrationEntry = ledger[view.id] ?? { providers: [] };
    const declared = new Set((view.presets ?? []).map((preset) => preset.providerId));
    // An UPGRADE can drop a preset the previous version shipped. Reconciling
    // here (not only on uninstall) is what keeps `providers.json` free of
    // providers backing a plugin version that no longer exists.
    for (const pid of entry.providers) {
      if (declared.has(pid)) continue;
      const current = readProviderDefsFile()?.providers?.[pid] as Record<string, unknown> | undefined;
      if (!current) continue; // already gone
      const ours = entry.written?.[pid] !== undefined ? matchesRegistration(entry.written[pid], current) : !isMeaningfulDef(current);
      if (ours) deleteProviderDef(pid);
    }
    const mine = new Set<string>();
    const written: Record<string, unknown> = {};
    // Tombstones this entry keeps after the pass (an id whose def reappeared is
    // connect intent and loses its tombstone below).
    const deleted = new Set(entry.deleted ?? []);
    for (const preset of view.presets ?? []) {
      const presetWire = currentProtocol(preset.protocol || preset.npm!);
      // A manifest protocol must be an OCR protocol id (ADR-0033: one protocol
      // vocabulary, never an SDK package): a core wire, or a wire some LOADED
      // plugin claims. Anything else — an SDK package from an older plugin
      // build, a typo — would be written as a def that can never
      // route (`wireFor` → `unroutable`), so refuse it at the write boundary and
      // name the offender instead of poisoning providers.json.
      if (!isCoreWire(presetWire) && !isPluginWire(presetWire)) {
        console.warn(
          `[OCR] plugins: preset '${preset.providerId}' of ${view.id} declares protocol '${preset.protocol ?? preset.npm}' which is not an OCR protocol id — skipped`
        );
        continue;
      }
      const raw = readProviderDefsFile()?.providers?.[preset.providerId] as Record<string, unknown> | undefined;
      if (deleted.has(preset.providerId)) {
        // The operator deleted this provider: never resurrect it. A def that is
        // BACK on disk means the operator connected it again (or re-created it
        // by hand) — that clears the tombstone and the normal rules apply.
        if (!raw) continue;
        deleted.delete(preset.providerId);
      }
      if (raw) {
        // Pre-existing def with the same id: a def WE wrote earlier keeps its
        // snapshot (so uninstall can still tell it apart from an operator
        // edit); a MEANINGFUL def is operator-owned and never overwritten —
        // it only joins the ledger, so uninstall leaves it alone. A BARE
        // stub (isMeaningfulDef === false) is machine residue, not operator
        // state: fall through and let the preset take the id over.
        if (presetWireIsBroken(raw)) {
          const repaired = repairPresetWire(raw, presetWire);
          const providers = { ...(readProviderDefsFile()?.providers ?? {}) };
          providers[preset.providerId] = repaired;
          writeProviderDefs(providers);
          mine.add(preset.providerId);
          written[preset.providerId] = repaired;
          created.push(preset.providerId);
          console.warn(
            `[OCR] plugins: repaired provider '${preset.providerId}' (plugin ${view.id}) — wire '${defWireOf(raw)}' -> '${presetWire}'`
          );
          continue;
        }
        if (entry.written?.[preset.providerId] !== undefined) {
          mine.add(preset.providerId);
          written[preset.providerId] = entry.written[preset.providerId];
          continue;
        }
        if (isMeaningfulDef(raw)) {
          mine.add(preset.providerId);
          continue;
        }
      }
      const result = upsertProviderDef({
        id: preset.providerId,
        name: presetDefName(preset),
        protocols: [presetWire],
        baseURL: preset.baseUrl,
      });
      if (result.success) {
        mine.add(preset.providerId);
        // Record EXACTLY what landed on disk: uninstall deletes this def only
        // while the file still matches, so an operator edit survives.
        const node = readProviderDefsFile()?.providers?.[preset.providerId];
        if (node !== undefined) written[preset.providerId] = node;
        created.push(preset.providerId);
      } else {
        console.warn(`[OCR] plugins: preset '${preset.providerId}' of ${view.id} failed to register: ${result.error}`);
      }
    }
    if (mine.size > 0 || deleted.size > 0) {
      ledger[view.id] = {
        providers: [...mine],
        ...(Object.keys(written).length > 0 ? { written } : {}),
        ...(deleted.size > 0 ? { deleted: [...deleted] } : {}),
      };
    }
  }
  // Orphan ledger rows: a package RENAMED between releases leaves its old id's
  // entry behind (this loop only iterates loaded ids, uninstall only deletes its
  // own key), so that row could never be read again — drop it. A DISABLED or
  // failed package keeps its row: uninstall still needs it to remove the defs.
  // Gated on a load that SAW plugins: an unreadable/empty root is not proof that
  // every ledger row is stale.
  if (hostInitialized && lastViews.length + disabledViews.length > 0) {
    const known = new Set([...lastViews, ...disabledViews].map((v) => v.id));
    for (const id of Object.keys(ledger)) if (!known.has(id)) delete ledger[id];
  }
  writeRegistrations(ledger);
  return created;
}

/** Operator CONNECT INTENT for a preset provider (the console's web-login
 *  button): lift the deletion tombstone and materialize the def when it is
 *  missing. Without this a provider the operator once deleted keeps advertising
 *  its login button (the row comes from the manifest) while every route answers
 *  `provider '…' not found`. Returns true when a def is on disk afterwards. */
export async function ensurePresetProvider(providerId: string): Promise<boolean> {
  for (const { view } of registry.values()) {
    const preset = (view.presets ?? []).find((p) => p.providerId === providerId);
    if (!preset) continue;
    // Same write-boundary rule as registration: a manifest that still declares
    // an SDK package must never materialize a def the core cannot route.
    const presetWire = currentProtocol(preset.protocol || preset.npm!);
    if (!isCoreWire(presetWire) && !isPluginWire(presetWire)) {
      console.warn(
        `[OCR] plugins: preset '${preset.providerId}' of ${view.id} cannot be materialized — protocol '${preset.protocol ?? preset.npm}' is not an OCR protocol id`
      );
      return false;
    }
    clearProviderDeletion(providerId);
    const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
    if (readProviderDefsFile()?.providers?.[providerId]) return true;
    const { upsertProviderDef } = await import('../opencode/user-config.js');
    return upsertProviderDef({
      id: preset.providerId,
      name: presetDefName(preset),
      protocols: [presetWire],
      baseURL: preset.baseUrl,
    }).success;
  }
  return false;
}

/** True when `wire` still has an executor once plugin `excludeId` is gone:
 *  core wires execute in-process, every other wire needs a loaded plugin that
 *  claims it (the OCR-native identity floor does NOT count — an absent plugin
 *  has no executor either way). */
function wireSurvivesWithout(wire: string, excludeId: string): boolean {
  if (isCoreWire(wire)) return true;
  for (const { view } of registry.values()) {
    if (view.id !== excludeId && view.wires.includes(wire)) return true;
  }
  return false;
}

/** Remove the provider defs a plugin auto-registered (hot-unplug half). */
async function removePluginRegistrations(id: string): Promise<string[]> {
  const { deleteProviderDef } = await import('../opencode/user-config.js');
  const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
  const ledger = readRegistrations();
  const entry = ledger[id];
  const removed: string[] = [];
  for (const pid of entry?.providers ?? []) {
    const current = readProviderDefsFile()?.providers?.[pid] as Record<string, unknown> | undefined;
    if (!current) continue;
    // A def whose wire has NO executor once this plugin is gone is dead state,
    // not operator content: delete it even when the node drifted (auto-pulled
    // models, headers) — otherwise every connected preset provider outlives the
    // plugin and lingers on the Connected surface forever. A def the operator
    // repointed to a routable wire still works without this plugin and stays.
    const currentWire = defWireOf(current);
    const dead = currentWire === 'unroutable' || !wireSurvivesWithout(currentWire, id);
    if (!dead) {
      // Operator-owned now (keyed models, rename, own baseURL) — uninstall must
      // not destroy it. Decided by DRIFT from what the plugin wrote: an exact
      // match is ours to remove. A def with no snapshot predates this ledger
      // (legacy `string[]`), so the old heuristic decides for it.
      const ours = entry?.written?.[pid] !== undefined ? matchesRegistration(entry.written[pid], current) : !isMeaningfulDef(current);
      if (!ours) continue;
    }
    const result = deleteProviderDef(pid);
    if (result.success) removed.push(pid);
  }
  delete ledger[id];
  writeRegistrations(ledger);
  return removed;
}

/** UI Lang short code → BCP-47 manifest locale key. Mirrors
 *  frontend/src/i18n/languages.ts LANG_TO_BCP47 — update both in the same
 *  commit. Values outside the table (already-BCP-47 codes) pass through. */
const LANG_TO_BCP47: Record<string, string> = {
  zh: 'zh-CN',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  de: 'de-DE',
  ja: 'ja-JP',
  ko: 'ko-KR',
  pt: 'pt-BR',
};

/** Catalog-side preset entries (merged into /opencode/catalog by the console
 *  route): one row per preset so the connect-catalog page can search, show
 *  the plugin logo and start a credential connection like any catalog
 *  provider.
 *  `lang` is the console's UI short code ('zh'/'en'/…); manifest locale maps
 *  key by BCP-47 ('zh-CN'/'en-US') — translated before lookup, en-US as the
 *  fallback. */
export async function pluginPresetCatalogEntries(lang?: string): Promise<
  { id: string; name: string; defaultName: string; logo?: string; protocols?: string[]; baseURL?: string; custom: boolean; connected: boolean; webLogin?: boolean; webLoginSubmit?: boolean; authTypes?: PluginAuthType[]; sources: ['service']; keyHint?: string }[]
> {
  const { getCredentialStore } = await import('../opencode/credentials/index.js');
  const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
  const store = await getCredentialStore();
  const defs = readProviderDefsFile()?.providers ?? {};
  const out: { id: string; name: string; defaultName: string; logo?: string; protocols?: string[]; baseURL?: string; custom: boolean; connected: boolean; webLogin?: boolean; webLoginSubmit?: boolean; authTypes?: PluginAuthType[]; sources: ['service']; keyHint?: string }[] = [];
  for (const { plugin, view } of registry.values()) {
    const logoUrl = view.logo ? `/api/admin/plugins/${view.id}/logo` : undefined;
    for (const preset of view.presets ?? []) {
      const key = lang ? (LANG_TO_BCP47[lang] ?? (lang.includes('-') ? lang : undefined)) : undefined;
      const name = typeof preset.displayName === 'string'
        ? preset.displayName
        : (preset.displayName[key ?? ''] ?? preset.displayName['en-US'] ?? Object.values(preset.displayName)[0] ?? preset.providerId);
      const defaultName = typeof preset.displayName === 'string' ? preset.displayName : preset.displayName['en-US'] ?? name;
      // Resolve the key-form hint to the console locale here — the dialog
      // receives plain text, same contract as `name`.
      const hint = preset.keyHint;
      const keyHint = typeof hint === 'string' ? hint : hint ? (hint[key ?? ''] ?? hint['en-US'] ?? Object.values(hint)[0]) : undefined;
      out.push({
        id: preset.providerId,
        name,
        defaultName,
        logo: logoUrl,
        protocols: [currentProtocol(preset.protocol || preset.npm!)],
        baseURL: preset.baseUrl,
        custom: true,
        // A plugin that owns login is connected when its def exists. A stored
        // key is not an account for it, and a missing key must not keep the
        // card on the connect form.
        connected: pluginDeclinesCredentials(plugin)
          ? Boolean(defs[preset.providerId])
          : Boolean(store.resolveKey(preset.providerId)?.key),
        // Console connect card offers the web-authorization button when the
        // plugin declares the capability (vendor knowledge stays in-plugin).
        webLogin: typeof plugin.webLogin === 'object',
        webLoginSubmit: typeof plugin.webLogin?.submit === 'function',
        // Ordered credential-method declaration (first = console default).
        authTypes: plugin.authTypes,
        sources: ['service'],
        keyHint,
      });
    }
  }
  return out;
}

/** Serve a plugin package's logo asset (path-safe: manifest-declared only). */
export function pluginLogoFile(id: string): string | undefined {
  if (!isValidPluginId(id)) return undefined;
  // Resolve over the LISTED VIEWS, not the provider registry: the registry holds
  // only packages with a model-service half, so a pure client-gateway package —
  // the rows that declare a brand mark most often — 404'd on its own manifest
  // field. A logo is a static asset of the package, not a capability of the live
  // host, so every row the console renders (loaded, disabled or refused) serves
  // the mark it advertises.
  for (const view of listInstalledPlugins()) {
    if (view.id !== id) continue;
    const rel = view.logo;
    if (!rel) return undefined;
    const file = resolve(view.path, rel);
    if (file !== view.path && !file.startsWith(view.path + sep)) return undefined; // manifest path escape
    return existsSync(file) ? file : undefined;
  }
  return undefined;
}

/** Package bytes for the console download. A dev-tree plugin is bundled and
 *  zipped on the fly with the SAME deterministic packer `plugins:build` uses
 *  (so the export is installable and byte-identical to the build output); a
 *  packaged plugin returns its installed zip verbatim. Bundling failures
 *  propagate — the route answers 500 with the build reason instead of a
 *  misleading 404. The zip FILE NAME is free-form in the discovery root, so
 *  match the manifest id first, then the canonical `<id>.zip` stem a corrupt
 *  package was surfaced under. */
export async function pluginPackageZip(id: string): Promise<Uint8Array | undefined> {
  if (!isValidPluginId(id)) return undefined;
  const devRoot = devSourceRoot();
  const devDir = devRoot ? join(devRoot, id) : undefined;
  if (devDir && existsSync(join(devDir, 'plugin.json'))) return bundlePluginDir(devDir);
  // Same precedence the loader applies, so the download is the copy the host
  // would actually run: shipped package first, then the operator install.
  const packaged = bundledPackagePath(id) ?? packagePathIn(pluginsRoot(), id);
  if (!packaged) return undefined;
  try {
    return new Uint8Array(readFileSync(packaged));
  } catch {
    return undefined;
  }
}

/** Console listing — views only, never plugin internals. Disabled plugins
 *  are listed (marked, code never imported) so the operator can re-enable. */
export function listInstalledPlugins(): PluginView[] {
  return [...lastViews, ...disabledViews];
}
/** Console config read: schema + merged values for one loaded plugin. */
export function getPluginConfig(
  id: string
): { schema: PluginConfigField[]; sections: PluginConfigSection[]; values: Record<string, unknown> } | undefined {
  const manifest = manifestsById.get(id);
  if (!manifest) return undefined;
  return {
    schema: manifest.configSchema ?? [],
    sections: manifest.configSections ?? [],
    values: mergedPluginConfig(id, manifest.configSchema),
  };
}

/** One package's advisory texts (`manifest.warningLabels`) for the renderers:
 *  the CLI prints setup advisories, the console maps the SAME code through this
 *  map when the code is not core-owned. Loaded packages only — a disabled or
 *  broken plugin has no advisories to render. */
export function getPluginWarningLabels(
  id: string
): Record<string, string | Record<string, string>> | undefined {
  return manifestsById.get(id)?.warningLabels;
}

/** Console config write: validate + persist + fire the plugin's optional
 *  onConfigChange. Returns the merged values and any validation warnings. */
export async function applyPluginConfig(
  id: string,
  values: Record<string, unknown>
): Promise<{ values: Record<string, unknown>; warnings: string[] }> {
  const manifest = manifestsById.get(id);
  if (!manifest) throw new Error('unknown or unloaded plugin');
  if (!manifest.configSchema?.length) throw new Error('plugin declares no configurable fields');
  const result = writePluginConfig(id, manifest.configSchema, values);
  // The leg switch is the one config value CORE consumes rather than forwards:
  // replacing the registry tier makes the operator's pick authoritative from the
  // NEXT request to a claimed host, with no restart and no package rebuild for a
  // value that lives in a JSON file. It runs before `onConfigChange` so a plugin
  // that warms its transports in that hook does so under the leg the operator
  // just chose.
  const gateway = getGatewayById(id);
  if (gateway) setGatewayOperatorEgress(id, operatorEgressChoice(result.values));
  const target = gateway ?? [...registry.values()].find((r) => r.view.id === id)?.plugin;
  try {
    await target?.onConfigChange?.(result.values);
  } catch (err) {
    // A failing hot-apply hook must not roll back a persisted save.
    console.warn(`[OCR] plugin ${id}: onConfigChange failed —`, err instanceof Error ? err.message : err);
  }
  return result;
}

