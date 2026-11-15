import { ClientAdapter, ClientActionResult, probeClientVersion } from './base.js';
import { CORE_ADAPTERS } from './core-adapters.js';
import { retiredClientHint } from './reserved.js';
import { ClientHookStatus } from '../types.js';
import { popularityRank } from '../../utils/popularity.js';
import { compareVersions } from '../../utils/semver.js';
import { getPluginClientAdapter, listPluginClientAdapters, pluginIdForClient } from './plugin-adapters.js';

/** The hooks this build ships (`core-adapters.ts`) — the authoritative answer
 *  for "what is always available", even before the plugin host has run. */
const adapters: Record<string, ClientAdapter> = CORE_ADAPTERS;

/** One-click roster order — the same popularity rank the harness rail uses (ADR-0015). */
const ORDERED_ADAPTERS = Object.values(adapters).sort(
  (a, b) => popularityRank(a.name) - popularityRank(b.name)
);

/**
 * Plugin load, once per process, for the callers that can run BEFORE the boot
 * load: the standalone `ocr` CLI never boots the server, so `ocr setup
 * <plugin client>` would otherwise resolve to "unknown client". The console
 * boots plugins first and this promise is therefore already resolved there.
 *
 * Failure is swallowed on purpose: a plugin host that cannot load must not
 * take the core hooks down with it.
 */
let pluginAdaptersReady: Promise<void> | undefined;

export async function ensurePluginClientAdapters(): Promise<void> {
  if (!pluginAdaptersReady) {
    pluginAdaptersReady = import('../../plugins/host.js')
      .then(async (host) => {
        if (!host.isPluginHostInitialized()) await host.loadInstalledPlugins();
      })
      .catch(() => undefined);
  }
  await pluginAdaptersReady;
}

/** CLI usage hint: every target, most popular first. */
export const CLIENT_TARGETS = ORDERED_ADAPTERS.map((adapter) => adapter.name).join(' | ');

export function getClientAdapter(name: string): ClientAdapter | null {
  const normalized = String(name || '').toLowerCase().trim();
  if (!normalized) return null;
  return adapters[normalized] ?? getPluginClientAdapter(normalized) ?? null;
}

/** One message for "this id resolves to no hook". The roster is CORE + plugin
 *  rows: once packages contribute hooks, the built-in list alone would tell an
 *  operator their installed client does not exist. A retired id gets its own
 *  answer — "renamed to X" is actionable, "unknown" is not. */
function unknownClientMessage(name: string): string {
  const hint = retiredClientHint(name);
  if (hint) return hint;
  return `Unknown client '${name}'. Supported clients: ${getAllClientAdapters().map((a) => a.name).join(', ')}`;
}

export function getAllClientAdapters(): ClientAdapter[] {
  // Plugin rows ride AFTER the built-in ones: they are additive, and the
  // console's roster order must not reshuffle when a package is installed.
  const contributed = listPluginClientAdapters().sort(
    (a, b) => popularityRank(a.name) - popularityRank(b.name) || a.name.localeCompare(b.name)
  );
  return [...ORDERED_ADAPTERS, ...contributed];
}

export async function getAllClientStatuses(): Promise<ClientHookStatus[]> {
  await ensurePluginClientAdapters();
  return Promise.all(
    getAllClientAdapters().map(async adapter => {
      const status = await adapter.getStatus();
      if (adapter.versionCmd) {
        const current = await probeClientVersion(adapter.versionCmd);
        if (current) {
          status.version = {
            current,
            min: adapter.minVersion,
            meetsMin: !adapter.minVersion || compareVersions(current, adapter.minVersion) >= 0,
          };
        }
      }
      // Ownership + launch surface are the REGISTRY's facts, not the hook's:
      // which package provides the row, and which `ocr <verb>` commands it
      // publishes. Stamped here so no console table and no CLI constant has to
      // know a client id in advance.
      const pluginId = pluginIdForClient(adapter.name);
      const launch = adapter.launchVerbs?.().map((v) => v.verb);
      return {
        ...status,
        hookKind: adapter.hookKind,
        ...(adapter.icon ? { icon: adapter.icon } : {}),
        ...(adapter.shortName ? { shortName: adapter.shortName } : {}),
        ...(pluginId ? { pluginId } : {}),
        ...(adapter.catalogPlugin ? { catalogPlugin: adapter.catalogPlugin } : {}),
        ...(launch && launch.length > 0 ? { launch } : {}),
      };
    })
  );
}

/**
 * Every passthrough launch verb any hook (core or package) publishes, in
 * roster order. The CLI resolves `ocr <verb>` from here instead of importing a
 * client module, so a packaged adapter's verbs work exactly like a built-in
 * one's and the help text is generated from the same list.
 */
type LaunchVerbRow = {
  client: string;
  verb: string;
  script: string;
  detached: boolean;
  summary?: string;
  missingHint?: string;
};

export function listLaunchVerbs(): LaunchVerbRow[] {
  const verbs: LaunchVerbRow[] = [];
  for (const adapter of getAllClientAdapters()) {
    for (const v of adapter.launchVerbs?.() ?? []) {
      verbs.push({ client: adapter.name, ...v });
    }
  }
  return verbs;
}

/** One launch verb by name, or undefined when nobody publishes it. */
export function findLaunchVerb(verb: string) {
  const key = String(verb ?? '').trim();
  return listLaunchVerbs().find((v) => v.verb === key);
}

export async function setupClient(
  name: string,
  options?: Parameters<ClientAdapter['setup']>[0]
): Promise<ClientActionResult> {
  // Plugin-contributed hooks (e.g. the packaged OpenCode proxy mode) are only
  // resolvable once the plugin host has run in this process.
  await ensurePluginClientAdapters();
  const adapter = getClientAdapter(name);
  if (!adapter) {
    return {
      success: false,
      message: unknownClientMessage(name),
    };
  }
  // The two opencode hooks are mutually exclusive — provider injection owns
  // opencode.json(c), proxy mode owns the service env. Enabling one decouples
  // the other first (only when actually hooked) so `hooked` status never shows
  // both at once; a failed sibling teardown is surfaced in the result message
  // instead of silently swallowed.
  let siblingNote = '';
  if (name === 'opencode' || name === 'opencode-gateway') {
    const sibling = name === 'opencode' ? 'opencode-gateway' : 'opencode';
    const siblingAdapter = getClientAdapter(sibling);
    if (siblingAdapter && (await siblingAdapter.getStatus()).hooked) {
      const r = await teardownClient(sibling).catch((err: unknown) => ({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      }));
      if (!r.success) siblingNote = ` (note: previous ${sibling} hook teardown failed: ${r.message})`;
    }
  }
  const result = await adapter.setup(options);
  return siblingNote && result.success ? { ...result, message: result.message + siblingNote } : result;
}
export async function teardownClient(
  name: string,
  options?: Parameters<ClientAdapter['teardown']>[0]
): Promise<ClientActionResult> {
  await ensurePluginClientAdapters();
  const adapter = getClientAdapter(name);
  if (!adapter) {
    return {
      success: false,
      message: unknownClientMessage(name),
    };
  }
  return adapter.teardown(options);
}
