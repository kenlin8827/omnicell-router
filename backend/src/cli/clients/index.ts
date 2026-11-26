import { ClientAdapter, ClientActionResult, probeClientVersion } from './base.js';
import { CORE_ADAPTERS } from './core-adapters.js';
import { retiredClientHint } from './reserved.js';
import { ClientHookStatus } from '../types.js';
import { popularityRank } from '../../utils/popularity.js';
import { compareVersions } from '../../utils/semver.js';
import { getPluginClientAdapter, listPluginClientAdapters, pluginClientRank, pluginIdForClient } from './plugin-adapters.js';
import { noteClientSetup } from './activity.js';

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
/** The host's advisory-label reader, kept so the CLI can render
 *  package-declared labels without importing the host statically (the host
 *  imports this module to register hooks — a static import would be a cycle). */
let readWarningLabels: ((id: string) => Record<string, string | Record<string, string>> | undefined) | undefined;

export async function ensurePluginClientAdapters(): Promise<void> {
  if (!pluginAdaptersReady) {
    pluginAdaptersReady = import('../../plugins/host.js')
      .then(async (host) => {
        readWarningLabels = host.getPluginWarningLabels;
        if (!host.isPluginHostInitialized()) await host.loadInstalledPlugins();
      })
      .catch(() => undefined);
  }
  await pluginAdaptersReady;
}

/** Advisory texts (`manifest.warningLabels`) declared by the package that owns
 *  this hook; undefined for a core hook or an unloaded package. */
export async function pluginWarningLabelsFor(
  name: string
): Promise<Record<string, string | Record<string, string>> | undefined> {
  await ensurePluginClientAdapters();
  const id = pluginIdForClient(name);
  return id ? readWarningLabels?.(id) : undefined;
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
    (a, b) =>
      (pluginClientRank(a.name) ?? Number.MAX_SAFE_INTEGER) - (pluginClientRank(b.name) ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name)
  );
  return [...ORDERED_ADAPTERS, ...contributed];
}

/**
 * Roster SWR cache: one snapshot of every adapter status. Fresh window answers
 * from memory (the raw reads are cheap but the assemble fans out over every
 * config file); past the window the STALE snapshot answers instantly while one
 * background rebuild refreshes — and `refresh: true` (the Clients page's
 * manual button) bypasses the cache outright, since a click that says
 * "refresh" must never show yesterday's hook state.
 */
const rosterCache: { at: number; rows: ClientHookStatus[]; rebuild?: Promise<ClientHookStatus[]> } = { at: 0, rows: [] };
const ROSTER_FRESH_MS = 15_000;

async function buildRoster(): Promise<ClientHookStatus[]> {
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
      const published = adapter.launchVerbs?.() ?? [];
      const launch = published.map((v) => v.verb);
      const launchAliases = published.flatMap((v) => v.aliases ?? []);
      return {
        ...status,
        hookKind: adapter.hookKind,
        ...(adapter.icon ? { icon: adapter.icon } : {}),
        ...(adapter.shortName ? { shortName: adapter.shortName } : {}),
        ...(pluginId ? { pluginId } : {}),
        ...(adapter.catalogPlugin ? { catalogPlugin: adapter.catalogPlugin } : {}),
        ...(launch.length > 0 ? { launch } : {}),
        ...(launchAliases.length > 0 ? { launchAliases } : {}),
      };
    })
  );
}

export function getAllClientStatuses(options?: { refresh?: boolean }): Promise<ClientHookStatus[]> {
  const publish = (build: Promise<ClientHookStatus[]>): Promise<ClientHookStatus[]> => {
    rosterCache.rebuild = build.then((rows) => {
      rosterCache.rows = rows;
      rosterCache.at = Date.now();
      rosterCache.rebuild = undefined;
      return rows;
    });
    return rosterCache.rebuild;
  };
  const hasSnapshot = rosterCache.at > 0;
  // Forced refresh and a cold cache both build inline; everything else
  // answers the snapshot immediately.
  if (options?.refresh || !hasSnapshot) return publish(buildRoster());
  if (Date.now() - rosterCache.at >= ROSTER_FRESH_MS && !rosterCache.rebuild) {
    // Background refresh: a failed rebuild never surfaces — the stale
    // snapshot stands until the next window.
    publish(buildRoster()).catch(() => {});
  }
  return Promise.resolve(rosterCache.rows);
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
  /** Retired spellings — resolved explicitly, never dispatched (see `ClientLaunchVerb.aliases`). */
  aliases?: string[];
  script: string;
  detached: boolean;
  summary?: string;
  missingHint?: string;
};

export function listLaunchVerbs(): LaunchVerbRow[] {
  const verbs: LaunchVerbRow[] = [];
  for (const adapter of getAllClientAdapters()) {
    for (const v of adapter.launchVerbs?.() ?? []) {
      const { aliases, ...row } = v;
      verbs.push({ client: adapter.name, ...row, ...(aliases && aliases.length > 0 ? { aliases } : {}) });
    }
  }
  return verbs;
}

/** One launch verb by name, or undefined when nobody publishes it. A retired
 *  alias names nobody here: it resolves only through `currentLaunchVerb`. */
export function findLaunchVerb(verb: string) {
  const key = String(verb ?? '').trim();
  return listLaunchVerbs().find((v) => v.verb === key);
}

/** The CURRENT spelling of a launch verb, whether `verb` is that spelling or a
 *  retired alias (`agy` → `antigravity-cli`), or undefined when nobody
 *  publishes either. Calls that must refuse a retired spelling use this. */
export function currentLaunchVerb(verb: string): string | undefined {
  const key = String(verb ?? '').trim().toLowerCase();
  if (!key) return undefined;
  for (const v of listLaunchVerbs()) {
    if (v.verb === key) return key;
    if ((v.aliases ?? []).includes(key)) return v.verb;
  }
  return undefined;
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
  // Hook exclusivity is package-declared (`ClientAdapter.exclusiveWith`, one
  // side naming the other is enough): enabling this hook tears down every
  // installed, actually-hooked sibling — the one this hook names, and any
  // installed hook that names this one — so `hooked` status never shows both
  // at once. A failed sibling teardown is surfaced in the result message
  // instead of silently swallowed.
  const siblingIds = new Set<string>(adapter.exclusiveWith ?? []);
  for (const other of getAllClientAdapters()) {
    if (other !== adapter && (other.exclusiveWith ?? []).includes(adapter.name)) siblingIds.add(other.name);
  }
  let siblingNote = '';
  for (const sibling of siblingIds) {
    const siblingAdapter = getClientAdapter(sibling);
    if (!siblingAdapter || siblingAdapter === adapter) continue;
    if (!(await siblingAdapter.getStatus()).hooked) continue;
    const r = await teardownClient(sibling).catch((err: unknown) => ({
      success: false,
      message: err instanceof Error ? err.message : String(err),
    }));
    if (!r.success) siblingNote += ` (note: previous ${sibling} hook teardown failed: ${r.message})`;
  }
  const result = await adapter.setup(options);
  // A hook flip invalidates the roster snapshot: the next read rebuilds.
  // The success moment is also the client's "接入" timestamp — the activity
  // ledger's fallback sort key, so a freshly hooked client floats up before
  // it has sent any traffic.
  if (result.success) {
    rosterCache.at = 0;
    noteClientSetup(name);
  }
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
  const result = await adapter.teardown(options);
  if (result.success) rosterCache.at = 0;
  return result;
}
