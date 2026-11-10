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
  ClientGatewayHost,
  ClientGatewayPlugin,
  ModelServicePlugin,
  ModelServicePluginHost,
  PluginAuthType,
  PluginConfigField,
  PluginConfigSection,
  PluginManifest,
  PluginView,
} from './types.js';
import { commitGateways, removeGateway, stageGateway, getGatewayById } from './gateways.js';
import { getGatewayChatServices } from '../surfaces/gateway-chat.js';
import { invalidatePluginConfigCache, mergedPluginConfig, pluginConfigPath, writePluginConfig } from './config.js';
import { assertSupportedPluginApi, isValidPluginId, validatePluginManifest } from './manifest.js';
import { forwardH2 } from '../forward-proxy/h2-forward.js';
import { getProxyCaller } from '../forward-proxy/caller-context.js';
import { forwardTo, proxyFail, RULE_REJECTED_MESSAGE, type ForwardTarget } from '../forward-proxy/server.js';
import { resolveUpstreamTls } from '../forward-proxy/upstream-tls.js';
import { isRuleRejected } from '../forward-proxy/egress.js';
/**
 * Plugin host: discovers, unpacks and loads plugins. Two types today
 * (ADR-0017): 'model-service' (outbound executors, registry below) and
 * 'client-gateway' (inbound SNI-host gateways, registered via gateways.ts).
 *
 * Discovery, in priority order. NOTHING is loaded from the checkout by default:
 * a source tree is read only when `OCR_PLUGIN_SRC_DIR` names one, so the console
 * lists what is INSTALLED rather than whatever happens to sit on disk.
 *   1. DEV  — `<OCR_PLUGIN_SRC_DIR>/<id>/plugin.json` (untracked source; opt-in)
 *   2. BUNDLED — `<ocrHome>/plugins/bundled/*.zip` (packages that ship WITH
 *      the app; nothing in the build pipeline writes here — a release or the
 *      operator places them — an operator install must not shadow one, and
 *      uninstall tombstones instead of deleting)
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

/** The APP-OWNED package tier: packages that ship WITH the app and are never
 *  operator-owned — they win precedence over an operator install, and uninstall
 *  only writes a tombstone. The current build pipeline populates nothing here;
 *  a release that decides to ship packages drops them in, and an operator can
 *  place one deliberately. Single definition: the loader and the ownership
 *  guards must agree on one location. */
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

/** The backend capabilities handed to every model-service plugin at load time.
 *  `dir` is the plugin's load root — the only asset root a packaged plugin has. */
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
    pluginDir: () => dir,
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
    catalog: () => getGatewayChatServices()?.catalog() ?? { tiers: [], models: [] },
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

function readManifest(dir: string): PluginManifest {
  const raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as unknown;
  validatePluginManifest(raw, 'invalid plugin.json');
  return raw as PluginManifest;
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

/** Import result: exactly one of the two plugin shapes is set (manifest type). */
async function importPlugin(
  dir: string,
  source: PluginView['source']
): Promise<{ plugin?: ModelServicePlugin; gateway?: ClientGatewayPlugin; view: PluginView }> {
  const manifest = readManifest(dir);
  assertSupportedPluginApi(manifest.apiVersion);
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
    createPlugin?: (host: ModelServicePluginHost | ClientGatewayHost) => ModelServicePlugin | ClientGatewayPlugin;
  };
  if (typeof mod.createPlugin !== 'function') throw new Error('plugin entry missing createPlugin(host)');
  // plugin.json IS the single manifest truth — the runtime module never
  // declares one (a TS literal would only drift from the JSON).
  const view: PluginView = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    wires: manifest.wires ?? [],
    description: manifest.description,
    presets: manifest.presets,
    logo: manifest.logo,
    source,
    path: dir,
    loaded: true,
  };
  if (manifest.type === 'client-gateway') {
    const gateway = mod.createPlugin(buildGatewayHostSdk(manifest, dir)) as ClientGatewayPlugin;
    if (!gateway || !Array.isArray(gateway.hosts) || gateway.hosts.length === 0 || typeof gateway.match !== 'function' || typeof gateway.handle !== 'function') {
      throw new Error('createPlugin returned no usable gateway (need hosts[], match(), handle())');
    }
    // Loaded packages only — a broken plugin must not expose a schema the
    // console could edit against, so the map is filled AFTER validation.
    manifestsById.set(manifest.id, manifest);
    return { gateway, view };
  }
  const plugin = mod.createPlugin({ ...buildHostSdk(manifest, dir), pull: await pluginPullServices() }) as ModelServicePlugin;
  if (!plugin || typeof plugin.createProvider !== 'function') throw new Error('createPlugin returned no createProvider()');
  manifestsById.set(manifest.id, manifest);
  return { plugin, view };
}

function viewWireKey(view: PluginView): string {
  return view.wires[0] ?? view.id;
}

function failedView(id: string, source: PluginView['source'], path: string, err: unknown): PluginView {
  return {
    id,
    name: id,
    version: '?',
    type: 'model-service',
    wires: [],
    source,
    path,
    loaded: false,
    error: err instanceof Error ? err.message : String(err),
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
  nextRegistry.clear();
  manifestsById.clear();
  invalidatePluginConfigCache();
  const views: PluginView[] = [];
  const devRoot = devSourceRoot();
  const disabled = readDisabled();
  disabledViews = [];
  const seenIds = new Set<string>();

  if (devRoot && existsSync(devRoot)) {
    for (const name of readdirSync(devRoot)) {
      const dir = join(devRoot, name);
      if (!existsSync(join(dir, 'plugin.json'))) continue;
      if (disabled.has(name)) {
        seenIds.add(name);
        disabledViews.push(stubDisabledView(name, dir, 'dev'));
        continue; // disabled: listed, never imported or registered
      }
      seenIds.add(name);
      try {
        const loaded = await importPlugin(dir, 'dev');
        loaded.view.loadedAt = Date.now();
        if (loaded.gateway) stageGateway(loaded.view.id, loaded.gateway);
        if (loaded.plugin) nextRegistry.set(viewWireKey(loaded.view), { plugin: loaded.plugin, view: loaded.view });
        views.push(loaded.view);
      } catch (err) {
        views.push(failedView(name, 'dev', dir, err));
      }
    }
  }

  const packRoot = pluginsRoot();
  // Deterministic precedence: packages shipped WITH the app (`bundled/`) win
  // over operator-installed ones, and file names sort inside each root. Dev
  // tree already won above. An id must never depend on readdir order.
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
        // `ocr-*` belongs to packages that ship with the app; an operator
        // install must not shadow one (and an upgrade must stay predictable).
        views.push(
          failedView(id, 'packaged', packagedPath, new Error("plugin id 'ocr-*' is reserved for packages shipped with the gateway"))
        );
        seenIds.add(id);
        continue;
      }
      if (seenIds.has(id)) {
        console.warn(`[OCR] plugins: duplicate id '${id}' — ${packagedPath} ignored (a higher-precedence copy already loaded)`);
        continue;
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
        if (loaded.gateway) stageGateway(loaded.view.id, loaded.gateway);
        if (loaded.plugin) nextRegistry.set(viewWireKey(loaded.view), { plugin: loaded.plugin, view: loaded.view });
        seenIds.add(id);
        views.push(loaded.view);
      } catch (err) {
        // Claim the id even when the load FAILS: a broken higher-precedence
        // copy must not let a lower-precedence package of the same id load
        // beside it (two console rows, ambiguous disable/uninstall).
        seenIds.add(id);
        views.push(failedView(id, 'packaged', packagedPath, err));
      }
    }
  }
  // Atomic swap: in-flight dispatch/probe never observe an empty registry —
  // and the gateway registry rides the same commit point.
  registry.clear();
  for (const [k, v] of nextRegistry) registry.set(k, v);
  nextRegistry.clear();
  commitGateways();
  lastViews = views;
  return views;
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
 *  shipped package is disabled by a tombstone and may never have been
 *  extracted), else a bare id row. */
function stubDisabledView(
  id: string,
  dir: string,
  source: PluginView['source'],
  packaged?: PluginManifest
): PluginView {
  try {
    const m = packaged ?? readManifest(dir);
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      type: m.type,
      wires: m.wires ?? [],
      description: m.description,
      presets: m.presets,
      logo: m.logo,
      source,
      path: dir,
      disabled: true,
      loaded: false,
    };
  } catch {
    return { id, name: id, version: '?', type: 'model-service', wires: [], source, path: dir, disabled: true, loaded: false };
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
  for (const entry of registry.values()) {
    if (entry.view.wires.includes(wire)) return entry;
  }
  return undefined;
}

export function getModelServicePlugin(wire: string): ModelServicePlugin | undefined {
  return getModelServicePluginEntry(wire)?.plugin;
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

/** Install an uploaded package: validate the zip carries a valid plugin.json,
 *  then store it canonically as `<manifest-id>.zip` — the uploaded file
 *  name is free-form and never becomes the id. Returns the manifest id. */
export function installPluginPackage(bytes: Uint8Array): { id: string } {
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
  assertSupportedPluginApi(manifest.apiVersion);
  // Ownership refusals come FIRST: a rejected install must not touch a single
  // plugin artifact. (Clearing the disabled ledger before this point used to
  // resurrect a tombstoned shipped package on the next reload.) Both answers
  // come from the MANIFEST id — file names in `bundled/` are free-form.
  if (bundledPackagePath(manifest.id)) {
    throw new Error(`'${manifest.id}' ships with the gateway — disable it from the plugins page instead of installing an override`);
  }
  if (manifest.id.startsWith('ocr-')) {
    throw new Error(`plugin id 'ocr-*' is reserved for packages shipped with the gateway`);
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
  return { id: manifest.id };
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

/** The package the HOST ships for `id`, if any. File names inside a discovery
 *  root are FREE-FORM (the id lives in the manifest), so every ownership
 *  question — "does the app ship this?", "is this install an override?",
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
    const entry = value as { providers?: unknown; written?: unknown };
    out[pluginId] = {
      providers: Array.isArray(entry.providers) ? entry.providers.filter((v): v is string => typeof v === 'string') : [],
      ...(entry.written && typeof entry.written === 'object' && !Array.isArray(entry.written)
        ? { written: entry.written as Record<string, unknown> }
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
  return out;
}

/** True when the def currently on disk is byte-for-byte what the plugin wrote
 *  (no operator edit since). `snapshot === undefined` means the ledger predates
 *  snapshots, so the caller falls back to the heuristic below. */
function matchesRegistration(snapshot: unknown, current: unknown): boolean {
  return snapshot !== undefined && JSON.stringify(snapshot) === JSON.stringify(current);
}

/** A MEANINGFUL def is operator-owned and never overwritten/deleted, and
 *  joins the ledger (provenance tag/filter). A bare stub (New-custom leftover:
 *  only a package field) is left un-ledgered so uninstall never deletes an
 *  operator file node the plugin never created; an existing node is NEVER
 *  taken over by a preset (syncPluginPresets skips every id already present).
 *  Reads the RAW defs-file node:
 *  getProviderNodeById returns a normalized view that derives npm/options from
 *  package+settings, which would make even a bare stub look meaningful. */
function isMeaningfulDef(raw: Record<string, unknown> | undefined): boolean {
  return Boolean(
    raw &&
      Object.entries(raw).some(([key, value]) => {
        if (key === 'package') return false; // a New-custom stub is ONLY a package field
        if (key === 'models') return Boolean(value && typeof value === 'object' && Object.keys(value as object).length > 0);
        return value !== undefined && value !== null && value !== '' && !(typeof value === 'object' && Object.keys(value as object).length === 0);
      })
  );
}

/** Register every not-yet-defined preset of every loaded plugin, and RETIRE the
 *  ones the plugin no longer declares. A preset is skipped whenever the defs
 *  file already holds ANY node with that id — even a bare New-custom stub — so
 *  presets never take over operator file state. Retirement uses the same drift
 *  rule as uninstall: a def still identical to what the plugin wrote is ours to
 *  delete; one the operator edited stays, it just stops being claimed.
 *  Returns the created provider ids (for boot/reload logging). */
export async function syncPluginPresets(): Promise<string[]> {
  const { upsertProviderDef, deleteProviderDef } = await import('../opencode/user-config.js');
  const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
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
    for (const preset of view.presets ?? []) {
      const raw = readProviderDefsFile()?.providers?.[preset.providerId] as Record<string, unknown> | undefined;
      if (raw) {
        // Pre-existing def with the same id: never overwritten (ADR-0010).
        // A def WE wrote earlier keeps its snapshot (so uninstall can still
        // tell it apart from an operator edit); any other def only joins the
        // ledger when MEANINGFUL, and then has no snapshot — so uninstall
        // leaves it alone (isMeaningfulDef fallback).
        if (entry.written?.[preset.providerId] !== undefined) {
          mine.add(preset.providerId);
          written[preset.providerId] = entry.written[preset.providerId];
        } else if (isMeaningfulDef(raw)) {
          mine.add(preset.providerId);
        }
        continue;
      }
      const result = upsertProviderDef({
        id: preset.providerId,
        name: typeof preset.displayName === 'string' ? preset.displayName : (preset.displayName['en-US'] ?? Object.values(preset.displayName)[0]),
        npm: preset.npm,
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
    if (mine.size > 0) ledger[view.id] = { providers: [...mine], ...(Object.keys(written).length > 0 ? { written } : {}) };
  }
  writeRegistrations(ledger);
  return created;
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
    // Operator-owned now (keyed models, rename, own baseURL) — uninstall must
    // not destroy it. Decided by DRIFT from what the plugin wrote: an exact
    // match is ours to remove. A def with no snapshot predates this ledger
    // (legacy `string[]`), so the old heuristic decides for it.
    const ours = entry?.written?.[pid] !== undefined ? matchesRegistration(entry.written[pid], current) : !isMeaningfulDef(current);
    if (!ours) continue;
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
  { id: string; name: string; defaultName: string; logo?: string; npm?: string; baseURL?: string; custom: boolean; connected: boolean; webLogin?: boolean; webLoginSubmit?: boolean; authTypes?: PluginAuthType[]; sources: ['service']; keyHint?: string }[]
> {
  const { getCredentialStore } = await import('../opencode/credentials/index.js');
  const store = await getCredentialStore();
  const out: { id: string; name: string; defaultName: string; logo?: string; npm?: string; baseURL?: string; custom: boolean; connected: boolean; webLogin?: boolean; webLoginSubmit?: boolean; authTypes?: PluginAuthType[]; sources: ['service']; keyHint?: string }[] = [];
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
        npm: preset.npm,
        baseURL: preset.baseUrl,
        custom: true,
        connected: Boolean(store.resolveKey(preset.providerId)?.key),
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
  for (const { view } of registry.values()) {
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
  const target = getGatewayById(id) ?? [...registry.values()].find((r) => r.view.id === id)?.plugin;
  try {
    await target?.onConfigChange?.(result.values);
  } catch (err) {
    // A failing hot-apply hook must not roll back a persisted save.
    console.warn(`[OCR] plugin ${id}: onConfigChange failed —`, err instanceof Error ? err.message : err);
  }
  return result;
}

