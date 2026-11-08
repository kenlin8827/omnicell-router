import { unzipSync } from 'fflate';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getOcrHomeDir } from '../cli/paths.js';
import { UpstreamError } from '../resilience/error-classifier.js';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../config/defaults.js';
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
import { invalidatePluginConfigCache, mergedPluginConfig, writePluginConfig } from './config.js';
import { validatePluginManifest } from './manifest.js';
import { forwardH2 } from '../forward-proxy/h2-forward.js';
import { forwardTo, proxyFail, RULE_REJECTED_MESSAGE, type ForwardTarget } from '../forward-proxy/server.js';
import { resolveUpstreamTls } from '../forward-proxy/upstream-tls.js';
import { isRuleRejected } from '../forward-proxy/egress.js';
/**
 * Plugin host: discovers, unpacks and loads plugins. Two types today
 * (ADR-0017): 'model-service' (outbound executors, registry below) and
 * 'client-gateway' (inbound SNI-host gateways, registered via gateways.ts).
 *
 * Discovery, in priority order (dev wins so `plugins:build` is optional in a
 * checkout that carries the untracked plugins/ tree):
 *   1. DEV  — `<repoRoot>/plugins/<id>/plugin.json` (untracked source)
 *   2. PACK — `<ocrHome>/plugins/*.zip` (zip built by
 *      `bun run plugins:build`, extracted to
 *      `<ocrHome>/plugins/unpacked/<id>/` when absent or stale, then imported)
 *
 * Packaging format: a plain zip (the FILE NAME is free-form) whose ROOT holds
 * `plugin.json` + the entry module (`index.ts`, executed by the Bun runtime)
 * plus any vendored assets. The plugin id always comes from the manifest,
 * never from the file name. Every plugin is loaded through the host SDK
 * below, so the packaged plugin never imports backend paths — the unpacked
 * directory has no `../../backend` sibling.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** backend/src/plugins -> repo root */
const REPO_ROOT = resolve(here, '..', '..', '..');

export function pluginsRoot(): string {
  const override = process.env.OCR_PLUGINS_DIR?.trim();
  if (override) return override;
  return join(getOcrHomeDir(), 'plugins');
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

/** The backend capabilities handed to every model-service plugin at load time. */
function buildHostSdk(manifest: PluginManifest): ModelServicePluginHost {
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
export function buildGatewayHostSdk(manifest: PluginManifest): ClientGatewayHost {
  return {
    log: (...args: unknown[]) => console.log('[OCR] gateway:', ...args),
    ocrHome: () => getOcrHomeDir(),
    config: () => mergedPluginConfig(manifest.id, manifest.configSchema),
    chat: (body, sink, signal) => {
      const svc = getGatewayChatServices();
      if (!svc) return Promise.reject(new Error('gateway chat services not wired (forward proxy disabled?)'));
      return svc.run(body, sink, signal);
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

/** Bare imports inside an UNPACKED plugin resolve against the gateway's own
 *  node_modules via a junction at <pluginsRoot>/node_modules (Windows-safe,
 *  no admin rights; dev-tree plugins resolve from the repo and skip this). */
function ensurePluginNodeModules(): void {
  const link = join(pluginsRoot(), 'node_modules');
  const target = join(REPO_ROOT, 'node_modules');
  if (!existsSync(target)) return;
  try {
    // Accept the link in any form (junction, symlink, real directory) —
    // re-creating over an existing real dir would warn EEXIST on every boot.
    if (existsSync(link)) return;
  } catch {
    // absent — create below
  }
  try {
    symlinkSync(target, link, 'junction');
  } catch (err) {
    console.warn(`[OCR] plugins: could not create node_modules junction (${err instanceof Error ? err.message : String(err)})`);
  }
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

/** Import result: exactly one of the two plugin shapes is set (manifest type). */
async function importPlugin(
  dir: string,
  source: PluginView['source']
): Promise<{ plugin?: ModelServicePlugin; gateway?: ClientGatewayPlugin; view: PluginView }> {
  const manifest = readManifest(dir);
  const entry = join(dir, 'index.ts');
  if (!existsSync(entry)) throw new Error('plugin entry index.ts missing');
  // Dynamic import: plugins load from a RUNTIME registry (dev dir / packaged
  // zip), never known at author time — plus the cache-bust below.
  // cache-bust: same id reinstalls reuse the same unpacked path, so a stable
  // import URL would serve the PREVIOUS version's module from the ESM cache
  const mod = (await import(`${pathToFileURL(entry).href}?v=${statSync(entry).mtimeMs}`)) as {
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
    const gateway = mod.createPlugin(buildGatewayHostSdk(manifest)) as ClientGatewayPlugin;
    if (!gateway || !Array.isArray(gateway.hosts) || gateway.hosts.length === 0 || typeof gateway.match !== 'function' || typeof gateway.handle !== 'function') {
      throw new Error('createPlugin returned no usable gateway (need hosts[], match(), handle())');
    }
    // Loaded packages only — a broken plugin must not expose a schema the
    // console could edit against, so the map is filled AFTER validation.
    manifestsById.set(manifest.id, manifest);
    return { gateway, view };
  }
  const plugin = mod.createPlugin({ ...buildHostSdk(manifest), pull: await pluginPullServices() }) as ModelServicePlugin;
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
  const devRoot = join(REPO_ROOT, 'plugins');
  const disabled = readDisabled();
  disabledViews = [];
  const seenIds = new Set<string>();

  if (existsSync(devRoot)) {
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
  if (existsSync(packRoot)) {
    ensurePluginNodeModules();
    for (const name of readdirSync(packRoot)) {
      if (!/\.zip$/i.test(name)) continue;
      const packagedPath = join(packRoot, name);
      // The id lives in the manifest, not the file name (which is free-form).
      // A corrupt/unreadable zip falls back to the file-name stem so the
      // failure still surfaces as a visible view instead of being skipped.
      const id = readPackagedId(packagedPath) ?? name.replace(/\.zip$/i, '');
      if (seenIds.has(id)) continue; // dev copy wins; first package wins too
      if (disabled.has(id)) {
        // No ensureUnpacked for disabled packages: their code stays dormant.
        disabledViews.push(stubDisabledView(id, join(packRoot, 'unpacked', id), 'packaged'));
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
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(disabledPath(), JSON.stringify([...ids], null, 2));
}

/** Stub views for disabled plugins: manifest facts from plugin.json when
 *  readable (code is NOT imported), a bare id row otherwise. */
let disabledViews: PluginView[] = [];
/** Every view (both plugin types, failures included) from the last full
 *  load — the console listing derives from this, NOT from the model-service
 *  registry, so gateways and boot-time failures stay visible (ADR-0017). */
let lastViews: PluginView[] = [];

function stubDisabledView(id: string, dir: string, source: PluginView['source']): PluginView {
  try {
    const m = readManifest(dir);
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
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error('invalid plugin id');
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
    throw new Error(`invalid plugin.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Installing expresses intent to USE the plugin: a stale disabled entry
  // must not make every reinstall fail — install clears it (mirrors
  // uninstall clearing the ledger too).
  const disabled = readDisabled();
  if (disabled.delete(manifest.id)) writeDisabled(disabled);
  mkdirSync(pluginsRoot(), { recursive: true });
  const dest = join(pluginsRoot(), `${manifest.id}.zip`);
  writeFileSync(dest, bytes);
  // a stale unpacked copy must not shadow the new package
  rmSync(join(pluginsRoot(), 'unpacked', manifest.id), { recursive: true, force: true });
  return { id: manifest.id };
}

function readManifestFromBytes(raw: Uint8Array): PluginManifest {
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  validatePluginManifest(parsed, 'invalid plugin.json');
  return parsed as PluginManifest;
}

/** Read just the manifest id from a packaged zip without unpacking it.
 *  Returns undefined when the zip or its manifest is unreadable. */
function readPackagedId(packagedPath: string): string | undefined {
  try {
    const files = unzipSync(new Uint8Array(readFileSync(packagedPath)));
    const raw = files['plugin.json'];
    if (!raw) return undefined;
    return readManifestFromBytes(raw).id;
  } catch {
    return undefined;
  }
}

/** Remove a plugin's package files only (no preset bookkeeping) — used by the
 *  install route when the uploaded package fails to load, so a broken package
 *  does not re-fail every boot. */
export function discardPluginPackage(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) return;
  const root = pluginsRoot();
  rmSync(join(root, `${id}.zip`), { force: true });
  rmSync(join(root, 'unpacked', id), { recursive: true, force: true });
}

/** Uninstall a plugin: remove its packaged zip, unpacked copy and the provider
 *  defs it auto-registered, then the caller reloads. Dev-tree plugins are OWNED by the operator's checkout —
 *  refuse and say so instead of deleting source files. */
export async function uninstallPlugin(
  id: string
): Promise<{ removed: string[]; providersRemoved: string[]; devOnly?: boolean }> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error('invalid plugin id');
  const removed: string[] = [];
  const packRoot = pluginsRoot();
  const packaged = join(packRoot, `${id}.zip`);
  if (existsSync(packaged)) {
    rmSync(packaged, { force: true });
    removed.push(packaged);
  }
  const unpacked = join(packRoot, 'unpacked', id);
  if (existsSync(unpacked)) {
    rmSync(unpacked, { recursive: true, force: true });
    removed.push(unpacked);
  }
  const providersRemoved = await removePluginRegistrations(id);
  removeGateway(id); // stop answering immediately; the caller's reload commits the full rebuild
  // An uninstalled plugin must not linger as a disabled stub row.
  const disabled = readDisabled();
  if (disabled.delete(id)) writeDisabled(disabled);
  if (removed.length === 0) {
    // Dev-tree plugin: its source directory is operator-owned, but any preset
    // providers it had registered are cleanly unregistered.
    if (providersRemoved.length > 0) return { removed, providersRemoved, devOnly: true };
    throw new Error(`no installed package found for '${id}' (dev-tree plugins are removed by deleting their directory)`);
  }
  return { removed, providersRemoved };
}

/** Hot-plug preset bookkeeping: installing/reloading a plugin REGISTERS every
 *  preset the plugin declares that is not already defined (existing operator
 *  defs are never overwritten); uninstalling REMOVES exactly the providers
 *  this plugin registered. The ledger lives beside the packages so a packaged
 *  install and its cleanup travel together. */
function registrationsPath(): string {
  return join(pluginsRoot(), 'registrations.json');
}

function readRegistrations(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(registrationsPath(), 'utf8')) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function writeRegistrations(map: Record<string, string[]>): void {
  mkdirSync(pluginsRoot(), { recursive: true });
  writeFileSync(registrationsPath(), JSON.stringify(map, null, 2));
}

/** Inverted preset ledger: providerId → owning plugin id. Read-only projection
 *  for console catalog tagging/filtering — providers.json itself stays
 *  unmarked (ADR-0010: the ledger, not the defs file, is the provenance truth). */
export function pluginProviderOrigins(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [pluginId, ids] of Object.entries(readRegistrations())) {
    for (const id of ids) out[id] = pluginId;
  }
  return out;
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

/** Register every not-yet-defined preset of every loaded plugin. A preset is
 *  skipped whenever the defs file already holds ANY node with that id — even a
 *  bare New-custom stub — so presets never take over operator file state.
 *  Returns the created provider ids (for boot/reload logging). */
export async function syncPluginPresets(): Promise<string[]> {
  const { upsertProviderDef } = await import('../opencode/user-config.js');
  const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
  const created: string[] = [];
  const ledger = readRegistrations();
  for (const { view } of registry.values()) {
    const mine = new Set(ledger[view.id] ?? []);
    for (const preset of view.presets ?? []) {
      const raw = readProviderDefsFile()?.providers?.[preset.providerId] as Record<string, unknown> | undefined;
      if (raw) {
        // Pre-existing operator def with the same id: never overwritten (ADR-0010).
        // Only a MEANINGFUL def joins the ledger (provenance tag/filter): a bare
        // stub is left un-ledgered so uninstall never deletes an operator file
        // node the plugin never created (isMeaningfulDef skips meaningful defs).
        if (isMeaningfulDef(raw)) mine.add(preset.providerId);
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
        created.push(preset.providerId);
      } else {
        console.warn(`[OCR] plugins: preset '${preset.providerId}' of ${view.id} failed to register: ${result.error}`);
      }
    }
    if (mine.size > 0) ledger[view.id] = [...mine];
  }
  writeRegistrations(ledger);
  return created;
}

/** Remove the provider defs a plugin auto-registered (hot-unplug half). */
async function removePluginRegistrations(id: string): Promise<string[]> {
  const { deleteProviderDef } = await import('../opencode/user-config.js');
  const { readProviderDefsFile } = await import('../opencode/provider-defs.js');
  const ledger = readRegistrations();
  const ids = ledger[id] ?? [];
  const removed: string[] = [];
  for (const pid of ids) {
    // A preset the operator has since customized (keyed models, rename, own
    // baseURL) is operator-owned now — uninstall must not destroy it.
    if (isMeaningfulDef(readProviderDefsFile()?.providers?.[pid] as Record<string, unknown> | undefined)) continue;
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
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) return undefined;
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

