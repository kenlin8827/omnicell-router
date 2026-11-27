/**
 * Follow-catalog auto-resync — event-driven rewrite of follow-mode snapshots.
 *
 * Triggers (callers): API key `modelAccess` edits (`reason: 'key'`) and live
 * model-pool rebuilds (`reason: 'pool'`). enabled / expiry / delete do not fire
 * — they only affect auth. Debounced, not polled. Targets:
 *   - config hooks with clientProfileMemory.modelMode === 'follow' + hooked
 *   - gateway plugins with modelListMode === 'follow' + bound key
 *
 * Auto path never sets acknowledgeRunning — running clients land in `pending`.
 * No background retry loop: debounce coalesces bursts; open issues wait for a
 * manual POST .../retry (may acknowledgeRunning) or the next key/pool event.
 * Auto-polling ide_running would write behind the operator's back; hard fails
 * (api_key_unusable, adapter errors) do not heal by waiting.
 * Not a profile write-through (ADR-0031): N targeted setups / plugin config writes.
 */
import {
  DEFAULT_AUTO_RESYNC_FOLLOW_CATALOGS,
  FOLLOW_CATALOG_KEY_DEBOUNCE_MS,
  FOLLOW_CATALOG_POOL_DEBOUNCE_MS,
} from '../../config/defaults.js';
import { loadConfig, saveConfig } from '../../config/index.js';
import type { ClientProfileMemoryEntry } from '../../config/types.js';
import { isApiKeyUsable, listApiKeys } from '../../auth/api-keys.js';
import { allowedFollowLists, buildKeyModelsView } from '../../auth/key-models.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { getClientAdapter, getAllClientAdapters, setupClient } from './index.js';

export type FollowCatalogSyncReason = 'key' | 'pool';

export type FollowCatalogSyncRequest = {
  reason: FollowCatalogSyncReason;
  keyId?: string;
};

export type FollowCatalogSyncError = {
  target: string;
  reason: string;
};

export type FollowCatalogSyncRun = {
  at: number;
  reason: FollowCatalogSyncReason;
  keyId?: string;
  synced: number;
  skipped: number;
  failed: number;
  errors: FollowCatalogSyncError[];
};

/** Per-target issue until a successful rewrite clears it (in-process; restart resets). */
export type FollowCatalogIssue = {
  id: string;
  kind: 'client' | 'gateway';
  /** pending = waiting (usually ide_running); failed = hard error. */
  status: 'pending' | 'failed';
  reason: string;
  apiKeyId?: string;
  at: number;
};

export type FollowCatalogSyncState = {
  enabled: boolean;
  /** Ids still waiting (subset of issues with status pending). */
  pending: string[];
  /** Ids with a hard failure (subset of issues with status failed). */
  failed: string[];
  /** Full issue list for console cards / banner. */
  issues: FollowCatalogIssue[];
  lastRun?: FollowCatalogSyncRun;
};

type TargetKind = 'client' | 'gateway';

type RetryEntry = {
  kind: TargetKind;
  id: string;
  apiKeyId: string;
};

let registryRef: ProviderRegistry | undefined;
const fingerprints = new Map<string, string>();
/** In-process until success — drives card/banner hints (cleared on restart). */
const issues = new Map<string, FollowCatalogIssue>();
let lastRun: FollowCatalogSyncRun | undefined;
let keyTimer: ReturnType<typeof setTimeout> | undefined;
let poolTimer: ReturnType<typeof setTimeout> | undefined;
/** Coalesce concurrent key edits — a single keyId would drop earlier keys. */
const pendingKeyIds = new Set<string>();
let inFlight: Promise<void> | undefined;

export function setFollowCatalogSyncRegistry(registry: ProviderRegistry | undefined): void {
  registryRef = registry;
}

/** Resolve the kill switch: explicit false disables; absent → default ON. */
export function isFollowCatalogAutoResyncEnabled(): boolean {
  const v = loadConfig().autoResyncFollowCatalogs;
  if (v === false) return false;
  if (v === true) return true;
  return DEFAULT_AUTO_RESYNC_FOLLOW_CATALOGS;
}

function fingerprintOf(ids: string[]): string {
  return [...ids].sort().join('\n');
}

function issueKey(kind: TargetKind, id: string): string {
  return `${kind}:${id}`;
}

function noteIssue(
  kind: TargetKind,
  id: string,
  status: 'pending' | 'failed',
  reason: string,
  apiKeyId?: string,
): void {
  issues.set(issueKey(kind, id), {
    id,
    kind,
    status,
    reason,
    ...(apiKeyId ? { apiKeyId } : {}),
    at: Date.now(),
  });
}

function clearIssue(kind: TargetKind, id: string): void {
  issues.delete(issueKey(kind, id));
}

export function getFollowCatalogSyncState(): FollowCatalogSyncState {
  const all = [...issues.values()];
  return {
    enabled: isFollowCatalogAutoResyncEnabled(),
    pending: all.filter((i) => i.status === 'pending').map((i) => i.id),
    failed: all.filter((i) => i.status === 'failed').map((i) => i.id),
    issues: all,
    ...(lastRun ? { lastRun } : {}),
  };
}

export function isFollowCatalogPending(clientOrPluginId: string): boolean {
  const c = issues.get(issueKey('client', clientOrPluginId));
  const g = issues.get(issueKey('gateway', clientOrPluginId));
  return c?.status === 'pending' || g?.status === 'pending';
}

/** Issue for a client name or its catalogPlugin id (card hint). */
export function getFollowCatalogIssue(
  clientOrPluginId: string,
): FollowCatalogIssue | undefined {
  return (
    issues.get(issueKey('client', clientOrPluginId)) ||
    issues.get(issueKey('gateway', clientOrPluginId))
  );
}

/**
 * Schedule a sync pass. Key edits coalesce into a Set (multi-key → one pool
 * pass so no earlier keyId is dropped); pool rebuilds share one 2s timer.
 */
export function requestFollowCatalogSync(req: FollowCatalogSyncRequest): void {
  if (!isFollowCatalogAutoResyncEnabled()) return;
  if (req.reason === 'key') {
    if (req.keyId) pendingKeyIds.add(req.keyId);
    if (keyTimer) clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      keyTimer = undefined;
      const ids = [...pendingKeyIds];
      pendingKeyIds.clear();
      if (ids.length === 0) {
        void runFollowCatalogSync({ reason: 'pool' });
      } else if (ids.length === 1) {
        void runFollowCatalogSync({ reason: 'key', keyId: ids[0] });
      } else {
        // Several keys changed inside the debounce window — one pool pass
        // covers every follow target instead of dropping all but the last id.
        void runFollowCatalogSync({ reason: 'pool' });
      }
    }, FOLLOW_CATALOG_KEY_DEBOUNCE_MS);
    return;
  }
  if (poolTimer) clearTimeout(poolTimer);
  poolTimer = setTimeout(() => {
    poolTimer = undefined;
    void runFollowCatalogSync({ reason: 'pool' });
  }, FOLLOW_CATALOG_POOL_DEBOUNCE_MS);
}

/** Retry every open issue (pending + failed). May pass acknowledgeRunning. */
export async function retryFollowCatalogPending(opts?: {
  acknowledgeRunning?: boolean;
}): Promise<FollowCatalogSyncRun> {
  const snapshot: RetryEntry[] = [...issues.values()]
    .filter((i) => !!i.apiKeyId)
    .map((i) => ({ kind: i.kind, id: i.id, apiKeyId: i.apiKeyId! }));
  // Nothing open: an empty retry must NOT fall through to a full pool pass —
  // that would re-setup every follow client and fabricate pending issues for
  // running apps the operator never asked to touch. Answer an empty run.
  if (issues.size === 0) {
    return {
      at: Date.now(),
      reason: 'pool',
      synced: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
  }
  // Issues without apiKeyId (rare) still need a rematch from memory/plugin —
  // fall through to a full pool pass when the snapshot is empty but issues remain.
  if (snapshot.length === 0) {
    return runFollowCatalogSync({
      reason: 'pool',
      acknowledgeRunning: opts?.acknowledgeRunning === true,
    });
  }
  return runFollowCatalogSync({
    reason: 'pool',
    onlyPending: snapshot,
    acknowledgeRunning: opts?.acknowledgeRunning === true,
  });
}

type RunOpts = FollowCatalogSyncRequest & {
  onlyPending?: RetryEntry[];
  acknowledgeRunning?: boolean;
};

async function runFollowCatalogSync(opts: RunOpts): Promise<FollowCatalogSyncRun> {
  // Serialize runs so a key edit mid-pool-pass does not interleave writes.
  const wait = inFlight ?? Promise.resolve();
  let resolve!: () => void;
  inFlight = new Promise<void>((r) => {
    resolve = r;
  });
  await wait;
  try {
    return await runFollowCatalogSyncInner(opts);
  } finally {
    resolve();
  }
}

async function runFollowCatalogSyncInner(opts: RunOpts): Promise<FollowCatalogSyncRun> {
  const run: FollowCatalogSyncRun = {
    at: Date.now(),
    reason: opts.reason,
    ...(opts.keyId ? { keyId: opts.keyId } : {}),
    synced: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  if (!isFollowCatalogAutoResyncEnabled() && !opts.onlyPending) {
    lastRun = run;
    return run;
  }
  const registry = registryRef;
  if (!registry) {
    run.failed += 1;
    run.errors.push({ target: '*', reason: 'registry_unavailable' });
    lastRun = run;
    return run;
  }

  if (opts.onlyPending && opts.onlyPending.length > 0) {
    for (const entry of opts.onlyPending) {
      if (entry.kind === 'client') {
        await syncConfigClient(entry.id, entry.apiKeyId, registry, run, opts.acknowledgeRunning === true);
      } else {
        await syncGatewayPlugin(entry.id, entry.apiKeyId, registry, run);
      }
    }
    lastRun = run;
    return run;
  }

  const mem = loadConfig().clientProfileMemory || {};
  for (const [name, entry] of Object.entries(mem)) {
    if (entry?.modelMode !== 'follow' || !entry.apiKeyId) continue;
    if (opts.reason === 'key' && opts.keyId && entry.apiKeyId !== opts.keyId) continue;
    await syncConfigClient(name, entry.apiKeyId, registry, run, false);
  }

  await syncAllGatewayFollow(opts, registry, run);

  lastRun = run;
  return run;
}

async function syncConfigClient(
  name: string,
  apiKeyId: string,
  registry: ProviderRegistry,
  run: FollowCatalogSyncRun,
  acknowledgeRunning: boolean,
): Promise<void> {
  // Checked here, not only in the caller's loop: a manual retry arrives from the
  // issue map, which a leave-follow edit that bypassed the stamp never visited.
  const memEntry = (loadConfig().clientProfileMemory || {})[name];
  if (memEntry?.modelMode !== 'follow') {
    clearIssue('client', name);
    fingerprints.delete(issueKey('client', name));
    run.skipped += 1;
    return;
  }
  const adapter = getClientAdapter(name);
  if (!adapter) {
    run.skipped += 1;
    return;
  }
  let status;
  try {
    status = await adapter.getStatus();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    run.failed += 1;
    run.errors.push({ target: name, reason });
    noteIssue('client', name, 'failed', reason, apiKeyId);
    return;
  }
  if (!status.hooked) {
    clearIssue('client', name);
    run.skipped += 1;
    return;
  }

  const keys = listApiKeys(false);
  const key = keys.find((k) => k.id === apiKeyId);
  if (!key || !isApiKeyUsable(key)) {
    run.failed += 1;
    run.errors.push({ target: name, reason: 'api_key_unusable' });
    noteIssue('client', name, 'failed', 'api_key_unusable', apiKeyId);
    return;
  }

  const view = buildKeyModelsView(apiKeyId, registry);
  if (view.status === 'error') {
    run.failed += 1;
    run.errors.push({ target: name, reason: view.message });
    noteIssue('client', name, 'failed', view.message, apiKeyId);
    return;
  }
  const { extraModels, virtualModels, allAllowedIds } = allowedFollowLists(view);
  const fp = fingerprintOf(allAllowedIds);
  if (fingerprints.get(issueKey('client', name)) === fp) {
    clearIssue('client', name);
    run.skipped += 1;
    return;
  }
  // Cold process: adapters usually echo concrete extras only — never stamp the
  // full (extras+virtuals) fingerprint from an extras-only match, or virtual
  // drift would be skipped forever after the first post-restart pass.

  const result = await setupClient(name, {
    apiKey: key.key,
    extraModels,
    virtualModels,
    ...(memEntry.models ? { models: memEntry.models } : {}),
    ...(memEntry.agentModels ? { agentModels: memEntry.agentModels } : {}),
    ...(typeof memEntry.contextWindow === 'number' && memEntry.contextWindow > 0
      ? { contextWindow: memEntry.contextWindow }
      : {}),
    ...(acknowledgeRunning ? { acknowledgeRunning: true } : {}),
  });

  if (!result.success) {
    if (result.reasonCode === 'ide_running') {
      noteIssue('client', name, 'pending', 'ide_running', apiKeyId);
      run.skipped += 1;
      run.errors.push({ target: name, reason: 'ide_running' });
      return;
    }
    const reason = result.reasonCode || result.message;
    run.failed += 1;
    run.errors.push({ target: name, reason });
    noteIssue('client', name, 'failed', reason, apiKeyId);
    return;
  }

  fingerprints.set(issueKey('client', name), fp);
  clearIssue('client', name);
  run.synced += 1;
}

async function syncAllGatewayFollow(
  opts: RunOpts,
  registry: ProviderRegistry,
  run: FollowCatalogSyncRun,
): Promise<void> {
  const host = await import('../../plugins/host.js');
  const installed = host.listInstalledPlugins();
  const installedById = new Map(installed.map((v) => [v.id, v]));
  for (const view of installed) {
    if (view.disabled) continue;
    const cfg = host.getPluginConfig(view.id);
    if (!cfg) continue;
    const mode = cfg.values.modelListMode;
    if (mode !== 'follow') continue;
    const keyField = cfg.schema.find((f) => f.control === 'apiKey')?.key;
    if (!keyField) continue;
    const bound = cfg.values[keyField];
    if (typeof bound !== 'string' || !bound.trim()) continue;
    if (opts.reason === 'key' && opts.keyId && bound !== opts.keyId) continue;
    await syncGatewayPlugin(view.id, bound, registry, run);
  }
  // Leave-follow / uninstall / disable: drop stale card issues. Do NOT use the
  // key-scoped visit set — a key-only pass legitimately skips other gateways.
  for (const issue of [...issues.values()]) {
    if (issue.kind !== 'gateway') continue;
    const row = installedById.get(issue.id);
    const cfg = host.getPluginConfig(issue.id);
    const stillFollow =
      !!row && !row.disabled && !!cfg && cfg.values.modelListMode === 'follow';
    if (!stillFollow) {
      clearIssue('gateway', issue.id);
      fingerprints.delete(issueKey('gateway', issue.id));
    }
  }
}

async function syncGatewayPlugin(
  pluginId: string,
  apiKeyId: string,
  registry: ProviderRegistry,
  run: FollowCatalogSyncRun,
): Promise<void> {
  const host = await import('../../plugins/host.js');
  const cfg = host.getPluginConfig(pluginId);
  if (!cfg) {
    run.skipped += 1;
    return;
  }
  if (cfg.values.modelListMode !== 'follow') {
    clearIssue('gateway', pluginId);
    run.skipped += 1;
    return;
  }
  const keys = listApiKeys(false);
  const key = keys.find((k) => k.id === apiKeyId);
  if (!key || !isApiKeyUsable(key)) {
    run.failed += 1;
    run.errors.push({ target: pluginId, reason: 'api_key_unusable' });
    noteIssue('gateway', pluginId, 'failed', 'api_key_unusable', apiKeyId);
    return;
  }
  const view = buildKeyModelsView(apiKeyId, registry);
  if (view.status === 'error') {
    run.failed += 1;
    run.errors.push({ target: pluginId, reason: view.message });
    noteIssue('gateway', pluginId, 'failed', view.message, apiKeyId);
    return;
  }
  const models = view.models.filter((m) => m.allowed).map((m) => m.id);
  const fp = fingerprintOf(models);
  const current = Array.isArray(cfg.values.models)
    ? cfg.values.models.map((id) => String(id).replace(/^ocr\//, ''))
    : [];
  if (fingerprints.get(issueKey('gateway', pluginId)) === fp || fingerprintOf(current) === fp) {
    fingerprints.set(issueKey('gateway', pluginId), fp);
    clearIssue('gateway', pluginId);
    run.skipped += 1;
    return;
  }
  try {
    await host.applyPluginConfig(pluginId, { ...cfg.values, models });
    for (const adapter of getAllClientAdapters()) {
      if (adapter.catalogPlugin !== pluginId || !adapter.refreshModelSurface) continue;
      try {
        await adapter.refreshModelSurface();
      } catch (err) {
        console.warn(
          `[follow-catalog] refreshModelSurface ${adapter.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    fingerprints.set(issueKey('gateway', pluginId), fp);
    clearIssue('gateway', pluginId);
    run.synced += 1;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    run.failed += 1;
    run.errors.push({ target: pluginId, reason });
    noteIssue('gateway', pluginId, 'failed', reason, apiKeyId);
  }
}

/** Persist modelMode / apiKeyId after a successful console setup (authoritative index). */
export function stampClientProfileMemory(
  clientName: string,
  patch: Partial<ClientProfileMemoryEntry>,
): void {
  const cfg = loadConfig();
  const mem = { ...(cfg.clientProfileMemory || {}) };
  const prev = mem[clientName] || {};
  mem[clientName] = { ...prev, ...patch };
  saveConfig({ clientProfileMemory: mem });
  // Leave-follow: drop card issue + fingerprint so a prior pending/fail does not linger.
  if (patch.modelMode !== undefined && patch.modelMode !== 'follow') {
    clearIssue('client', clientName);
    fingerprints.delete(issueKey('client', clientName));
  } else if (patch.modelMode === 'follow') {
    // Fresh follow setup succeeded — clear any stale auto-sync residue.
    clearIssue('client', clientName);
  }
}

/** Drop follow index on teardown so unloaded clients are not auto-synced. */
export function clearClientProfileMemory(clientName: string): void {
  const cfg = loadConfig();
  const mem = { ...(cfg.clientProfileMemory || {}) };
  if (!(clientName in mem)) return;
  delete mem[clientName];
  saveConfig({ clientProfileMemory: mem });
  clearIssue('client', clientName);
  fingerprints.delete(issueKey('client', clientName));
}

/** Test helpers — reset in-process state between cases. */
export function _resetFollowCatalogSyncForTests(): void {
  if (keyTimer) clearTimeout(keyTimer);
  if (poolTimer) clearTimeout(poolTimer);
  keyTimer = undefined;
  poolTimer = undefined;
  pendingKeyIds.clear();
  fingerprints.clear();
  issues.clear();
  lastRun = undefined;
  inFlight = undefined;
}
