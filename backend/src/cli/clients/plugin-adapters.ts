import type { ClientAdapter } from './base.js';
import { isCoreClientId, RETIRED_CLIENT_IDS } from './reserved.js';

/**
 * Client adapters contributed by PLUGINS (`type: 'client-adapter'`, ADR-0027).
 *
 * Kept apart from the core registry on purpose:
 *
 *  - the core registry is the answer to "what can this build hook?", a fixed
 *    map keyed by the reserved id list in `reserved.ts` — compile-time
 *    knowledge the CLI help text, the console roster and the i18n labels are
 *    built on;
 *  - this map is the answer to "what has this install additionally hooked?",
 *    which changes at runtime (install / uninstall / disable / a failed load)
 *    and must never be able to shadow a core id.
 *
 * The lookup order in `clients/index.ts` is core first, so a package can never
 * silently replace a built-in hook — a colliding id is REFUSED at load with the
 * package's own error message instead of becoming a row whose behaviour
 * depends on which copy happened to register last.
 *
 * The plugin host owns the write side and rebuilds TRANSACTIONALLY, exactly
 * like the gateway registry: `beginPluginClientAdapterRebuild()` opens a
 * staging map, each loaded package registers into it, and
 * `commitPluginClientAdapterRebuild()` swaps it in. A rebuild that throws
 * before the commit therefore leaves the PREVIOUS adapter set live instead of
 * an empty one — a failed scan must not blind the Client Hub while the proxy
 * legs keep serving. Registration outside a rebuild (tests, callers without a
 * host) writes to the live map.
 */
const byName = new Map<string, { pluginId: string; adapter: ClientAdapter }>();
/** Staging target while a rebuild is open; undefined = write live. */
let staged: Map<string, { pluginId: string; adapter: ClientAdapter }> | undefined;

/** Open a rebuild: registrations land in a staging map until the commit. */
export function beginPluginClientAdapterRebuild(): void {
  staged = new Map();
}

/** Swap the staged set in — the one point where a rebuild becomes visible. */
export function commitPluginClientAdapterRebuild(): void {
  if (!staged) return;
  byName.clear();
  for (const [name, entry] of staged) byName.set(name, entry);
  staged = undefined;
}

/** Drop every plugin adapter (live AND staged) — the test reset path. */
export function clearPluginClientAdapters(): void {
  byName.clear();
  staged = undefined;
}

/**
 * Register one adapter. Throws when the id belongs to a core hook or was
 * already claimed by another package: both are package-authoring mistakes and
 * must surface as a load error on the plugin's own console row, never as a
 * silent override.
 */
export function registerPluginClientAdapter(pluginId: string, adapter: ClientAdapter): void {
  const name = String(adapter?.name ?? '').trim().toLowerCase();
  if (!name) throw new Error('client-adapter plugin returned no adapter name');
  if (isCoreClientId(name)) {
    throw new Error(`client '${name}' is provided by this build — a plugin cannot replace a built-in hook`);
  }
  // A retired id is refused too, and for a different reason: its replacement
  // already registers the SAME client, so allowing both would put two rows on
  // one client, each with its own sidecar, fighting over the same settings.
  const retirement = Object.hasOwn(RETIRED_CLIENT_IDS, name) ? RETIRED_CLIENT_IDS[name] : undefined;
  if (retirement) {
    throw new Error(
      `client '${name}' moved into '${retirement}' — uninstall this package and install '${retirement}' instead (both cannot hook the same client)`
    );
  }
  const target = staged ?? byName;
  const existing = target.get(name);
  if (existing && existing.pluginId !== pluginId) {
    throw new Error(`client '${name}' is already provided by plugin '${existing.pluginId}'`);
  }
  target.set(name, { pluginId, adapter });
}

/** One plugin-contributed adapter by client id (core lookup already missed). */
export function getPluginClientAdapter(name: string): ClientAdapter | undefined {
  return byName.get(name)?.adapter;
}

/** Which package provides this client hook — undefined for a core hook. */
export function pluginIdForClient(name: string): string | undefined {
  return byName.get(String(name ?? '').trim().toLowerCase())?.pluginId;
}

/** All plugin-contributed adapters, registration order. */
export function listPluginClientAdapters(): ClientAdapter[] {
  return [...byName.values()].map((entry) => entry.adapter);
}
