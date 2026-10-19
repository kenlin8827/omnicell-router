import fs from 'node:fs';
import {
  CredentialPaths,
  credentialSyncFile,
  defaultEnv,
  resolveDefaultPaths,
} from './paths.js';
import { CredentialStore, StoreUnreadableError, keyHashPrefix } from './types.js';
import { DbOpener, OpencodeV2Store, resolveServiceConfigForPaths } from './opencode-v2-store.js';
import { atomicWriteWithRetry } from './factory.js';
import { OcrStore } from './ocr-store.js';

/**
 * Credential sync — per-client credential propagation with the OCR file
 * (<ocrHome>/credentials.json) as the single truth.
 *
 * The bound store is ALWAYS the OcrStore (factory decision). opencode v2 is a
 * SYNC CLIENT, not an alternative truth:
 *  - read  ("pull"): opencode v2 db -> OCR file. New api-key rows (keyHash
 *    dedup) land in the OCR file; oauth/wellknown rows never leave the client
 *    (the OAuth boundary — a token is not an api key).
 *  - write ("push"): OCR file -> opencode v2, through its HTTP management API
 *    (never raw sqlite writes). Local OCR entries are KEPT — OCR is the truth,
 *    so a push converges the client toward the OCR file without ever deleting
 *    from it (push-only convergence, minus the legacy local removal).
 *
 * State lives in <ocrHome>/credential-sync.json: per-client autoRead/autoWrite
 * toggles, last read/write timestamps + outcomes, and the one-shot v2
 * migration marker. Display-safe metadata only — no key material anywhere in
 * the state file or in any outcome.
 */

export type SyncClientId = 'opencode-v2';
export type SyncDirection = 'read' | 'write';
export type SyncDirectionRequest = SyncDirection | 'both';

/** The one client OCR can sync with today. */
export const SYNC_CLIENT_ID: SyncClientId = 'opencode-v2';
export const SYNC_CLIENT_LABEL = 'OpenCode V2';

export interface SyncEntryRecord {
  provider: string;
  action: 'pulled' | 'deduped' | 'failed' | 'pushed';
  reason?: string;
}

/** Machine-readable gate failure for a run that attempted nothing. */
export type SyncPrecondition =
  | 'db_absent'
  | 'db_unreadable'
  | 'opencode_v2_service_unreachable'
  | 'opencode_v2_db_unreadable';

export interface SyncRunOutcome {
  ok: boolean;
  precondition?: SyncPrecondition;
  pulled?: number;
  pushed?: number;
  deduped?: number;
  entries: SyncEntryRecord[];
  /** write runs only — (provider, keyHashPrefix) pairs that converged (SUSPECT lift). */
  pushedKeys?: { provider: string; keyHashPrefix: string }[];
  detail?: string;
}

export interface ClientSyncState {
  autoRead: boolean;
  autoWrite: boolean;
  lastReadAt?: number;
  lastWriteAt?: number;
  lastRead?: SyncRunOutcome;
  lastWrite?: SyncRunOutcome;
}

export interface SyncMigrationRecord {
  doneAt: number;
  pulled: number;
  deduped: number;
  failed: number;
  entries: SyncEntryRecord[];
}

export interface SyncStateFile {
  version: 1;
  clients: Partial<Record<SyncClientId, ClientSyncState>>;
  migration?: SyncMigrationRecord;
}

export interface SyncOverrides {
  paths?: CredentialPaths;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  openDatabase?: DbOpener;
  log?: SyncLogSink;
  /** Auto-read poll interval (ms). Default 60_000. */
  autoReadPollMs?: number;
  /** Auto-write debounce after an OCR mutation (ms). Default 1_500. */
  writeDebounceMs?: number;
}

/** Minimal structured sink; boot passes console lines, tests capture. */
export interface SyncLogSink {
  info(msg: string): void;
  warn(msg: string): void;
}

const LOG_PREFIX = '[sync]';
const defaultLog: SyncLogSink = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

// ---------------------------------------------------------------------------
// State file — additive, tolerant readers, atomic merge writes.
// ---------------------------------------------------------------------------

/** Tolerant read: any absence/corruption = the empty default (toggles off). */
export function readSyncState(paths: CredentialPaths = resolveDefaultPaths()): SyncStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialSyncFile(paths), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      return { version: 1, clients: {} };
    }
    return {
      version: 1,
      clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
      ...(parsed.migration && typeof parsed.migration === 'object' ? { migration: parsed.migration } : {}),
    };
  } catch {
    return { version: 1, clients: {} };
  }
}

/** Atomic merge write. Best-effort — a lost state write only loses timestamps/toggles. */
export function writeSyncState(paths: CredentialPaths, rec: SyncStateFile): void {
  try {
    atomicWriteWithRetry(credentialSyncFile(paths), `${JSON.stringify(rec, null, 2)}\n`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} failed to persist sync state: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function clientStateOf(rec: SyncStateFile): ClientSyncState {
  const c = rec.clients[SYNC_CLIENT_ID];
  return {
    autoRead: c?.autoRead === true,
    autoWrite: c?.autoWrite === true,
    ...(c?.lastReadAt !== undefined ? { lastReadAt: c.lastReadAt } : {}),
    ...(c?.lastWriteAt !== undefined ? { lastWriteAt: c.lastWriteAt } : {}),
    ...(c?.lastRead ? { lastRead: c.lastRead } : {}),
    ...(c?.lastWrite ? { lastWrite: c.lastWrite } : {}),
  };
}

/** Merge-write one direction's outcome (timestamps + audit) for the client. */
export function recordSyncOutcome(
  direction: SyncDirection,
  outcome: SyncRunOutcome,
  overrides: SyncOverrides = {}
): ClientSyncState {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const now = overrides.now ?? Date.now;
  const rec = readSyncState(paths);
  const client = clientStateOf(rec);
  const next: ClientSyncState = {
    ...client,
    ...(direction === 'read'
      ? { lastReadAt: now(), lastRead: outcome }
      : { lastWriteAt: now(), lastWrite: outcome }),
  };
  writeSyncState(paths, { ...rec, clients: { ...rec.clients, [SYNC_CLIENT_ID]: next } });
  return next;
}

/** Persist an auto-sync toggle. Returns the updated client state. */
export function setSyncAutoToggle(
  direction: SyncDirection,
  enabled: boolean,
  overrides: SyncOverrides = {}
): ClientSyncState {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const rec = readSyncState(paths);
  const client = clientStateOf(rec);
  const next: ClientSyncState = {
    ...client,
    ...(direction === 'read' ? { autoRead: enabled } : { autoWrite: enabled }),
  };
  writeSyncState(paths, { ...rec, clients: { ...rec.clients, [SYNC_CLIENT_ID]: next } });
  return next;
}

/** Masked status view for the console route — no key material, ever. */
export function credentialSyncStatusView(overrides: SyncOverrides = {}): {
  clients: Array<ClientSyncState & { id: SyncClientId; label: string; present: boolean; serviceConfigured: boolean }>;
} {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();
  const client = clientStateOf(readSyncState(paths));
  return {
    clients: [
      {
        id: SYNC_CLIENT_ID,
        label: SYNC_CLIENT_LABEL,
        present: fs.existsSync(paths.opencodeDbPath),
        serviceConfigured: Boolean(resolveServiceConfigForPaths(paths, env)),
        ...client,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Read sync (pull): opencode v2 db -> OCR file.
// ---------------------------------------------------------------------------

/**
 * Pull every routable (api-key) credential row from the opencode v2 db into
 * the OCR file. keyHash dedup against the OCR file makes reruns idempotent.
 * oauth/wellknown rows never surface here — resolveKeyChain exposes routable
 * api rows only (the OAuth boundary). Never throws: gate failures come back
 * as preconditions, per-entry failures as entries.
 */
export async function pullV2IntoOcr(
  ocr: CredentialStore,
  overrides: SyncOverrides = {}
): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();

  if (!fs.existsSync(paths.opencodeDbPath)) {
    return { ok: false, precondition: 'db_absent', entries: [] };
  }
  let v2: OpencodeV2Store;
  try {
    const deps: Parameters<typeof OpencodeV2Store.create>[0] = { paths, writable: false };
    if (overrides.openDatabase) deps.openDatabase = overrides.openDatabase;
    if (overrides.now) deps.now = overrides.now;
    v2 = await OpencodeV2Store.create(deps);
  } catch (e) {
    if (e instanceof StoreUnreadableError) {
      log.warn(`${LOG_PREFIX} read: opencode v2 db unreadable — ${e.message}`);
      return { ok: false, precondition: 'db_unreadable', entries: [], detail: e.message };
    }
    throw e;
  }

  try {
    const entries: SyncEntryRecord[] = [];
    let pulled = 0;
    let deduped = 0;
    for (const overview of v2.accountsOverview()) {
      const providerId = overview.providerId;
      // P3-1 alignment: own-property guard before the OCR write path —
      // connectKey re-validates provider ids, this only skips early.
      if (!providerId) continue;
      let localPrefixes: Set<string>;
      try {
        localPrefixes = new Set(
          ocr
            .listAccounts(providerId)
            .map((a) => a.keyHashPrefix ?? '')
            .filter(Boolean)
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        entries.push({ provider: providerId, action: 'failed', reason: `local store unreadable: ${msg}` });
        continue;
      }
      for (const cred of v2.resolveKeyChain(providerId)) {
        const prefix = keyHashPrefix(cred.key);
        if (localPrefixes.has(prefix)) {
          entries.push({ provider: providerId, action: 'deduped' });
          deduped += 1;
          continue;
        }
        try {
          await ocr.connectKey(providerId, cred.key, cred.label);
          entries.push({ provider: providerId, action: 'pulled' });
          pulled += 1;
          localPrefixes.add(prefix);
          log.info(`${LOG_PREFIX} read: ${providerId} pulled (key ${prefix})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          entries.push({ provider: providerId, action: 'failed', reason: msg });
          log.warn(`${LOG_PREFIX} read: ${providerId} pull failed — ${msg}`);
        }
      }
    }
    return { ok: !entries.some((e) => e.action === 'failed'), pulled, deduped, entries };
  } finally {
    v2.close(); // one transient readonly handle per pull — do not leak it
  }
}

// ---------------------------------------------------------------------------
// Write sync (push): OCR file -> opencode v2 (HTTP API, local entries KEPT).
// ---------------------------------------------------------------------------

/**
 * Push every OCR api-key credential into the opencode v2 service. The
 * single-truth direction is OCR -> client: local OCR entries are NEVER
 * removed (a failed push keeps the local copy; a successful one ALSO keeps
 * it — the OCR file remains the truth the console reads and writes).
 * Dedup is (provider case-insensitive × keyHash prefix) against the live v2
 * db, so reruns are idempotent. Never throws.
 */
export async function pushOcrIntoV2(
  ocr: CredentialStore,
  overrides: SyncOverrides & { provider?: string } = {}
): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();

  // Collect BEFORE the service gate: "nothing to push" is a plain ok even when
  // opencode is down — a manual sync with an empty OCR file must not fake-fail.
  const providerIds = overrides.provider
    ? [overrides.provider]
    : ocr.accountsOverview().map((a) => a.providerId);
  const local: { cred: ReturnType<CredentialStore['resolveKeyChain']>[number] }[] = [];
  for (const id of providerIds) {
    for (const cred of ocr.resolveKeyChain(id)) local.push({ cred });
  }
  if (local.length === 0) return { ok: true, pushed: 0, deduped: 0, entries: [], pushedKeys: [] };

  if (!resolveServiceConfigForPaths(paths, env)) {
    return { ok: false, precondition: 'opencode_v2_service_unreachable', entries: [] };
  }

  let v2: OpencodeV2Store;
  try {
    const createDeps: Parameters<typeof OpencodeV2Store.create>[0] = { paths, writable: true, env };
    if (overrides.fetchImpl) createDeps.fetchImpl = overrides.fetchImpl;
    if (overrides.now) createDeps.now = overrides.now;
    if (overrides.openDatabase) createDeps.openDatabase = overrides.openDatabase;
    v2 = await OpencodeV2Store.create(createDeps);
  } catch (e) {
    if (e instanceof StoreUnreadableError) {
      log.warn(`${LOG_PREFIX} write: opencode v2 db unreadable — ${e.message}`);
      return { ok: false, precondition: 'opencode_v2_db_unreadable', entries: [], detail: e.message };
    }
    throw e;
  }

  try {
    const index = indexV2KeyHashes(v2, log);
    const entries: SyncEntryRecord[] = [];
    const pushedKeys: { provider: string; keyHashPrefix: string }[] = [];
    let pushed = 0;
    let deduped = 0;
    for (const { cred } of local) {
      const prefix = keyHashPrefix(cred.key);
      const bucket = index.get(cred.providerId.toLowerCase());
      if (bucket?.has(prefix)) {
        entries.push({ provider: cred.providerId, action: 'deduped' });
        deduped += 1;
        pushedKeys.push({ provider: cred.providerId, keyHashPrefix: prefix });
        continue;
      }
      try {
        await v2.connectKey(cred.providerId, cred.key, cred.label);
        entries.push({ provider: cred.providerId, action: 'pushed' });
        pushed += 1;
        pushedKeys.push({ provider: cred.providerId, keyHashPrefix: prefix });
        log.info(`${LOG_PREFIX} write: ${cred.providerId} pushed (key ${prefix})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        entries.push({ provider: cred.providerId, action: 'failed', reason: msg });
        log.warn(`${LOG_PREFIX} write: ${cred.providerId} push failed — ${msg}; local entry kept`);
      }
    }
    return { ok: !entries.some((e) => e.action === 'failed'), pushed, deduped, entries, pushedKeys };
  } finally {
    v2.close();
  }
}

/** KeyHash dedup index of the v2 db's current credentials (hash primary). */
function indexV2KeyHashes(v2: CredentialStore, log: SyncLogSink): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  try {
    for (const overview of v2.accountsOverview()) {
      for (const meta of v2.listAccounts(overview.providerId)) {
        if (!meta.keyHashPrefix) continue;
        const bucket = index.get(meta.providerId.toLowerCase());
        if (bucket) bucket.add(meta.keyHashPrefix);
        else index.set(meta.providerId.toLowerCase(), new Set([meta.keyHashPrefix]));
      }
    }
  } catch (e) {
    log.warn(`${LOG_PREFIX} could not index v2 credentials for dedup: ${e instanceof Error ? e.message : String(e)}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// One-shot v2 migration — routing continuity for the store flip.
// ---------------------------------------------------------------------------

/**
 * First boot after the flip on a machine whose keys lived ONLY in the
 * opencode v2 db: pull them into the OCR file ONCE so routing continues
 * uninterrupted (the pool now reads the OCR file exclusively). Marker-gated
 * in credential-sync.json. Idempotent via keyHash dedup; any failed entry (or
 * an unreadable db) withholds the marker so the next boot retries. Total
 * function — never throws.
 */
export async function maybeRunV2Migration(
  ocr: CredentialStore,
  overrides: SyncOverrides = {}
): Promise<void> {
  const log = overrides.log ?? defaultLog;
  const now = overrides.now ?? Date.now;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const rec = readSyncState(paths);
  if (rec.migration?.doneAt) return;

  const outcome = await pullV2IntoOcr(ocr, overrides);
  if (outcome.precondition === 'db_absent') return; // nothing to migrate (yet) — no marker, zero cost
  if (!outcome.ok) {
    log.warn(
      `${LOG_PREFIX} v2 migration incomplete (${outcome.precondition ?? 'entry failures'}) — marker withheld, retried next boot`
    );
    return;
  }
  const failed = outcome.entries.filter((e) => e.action === 'failed').length;
  if (failed > 0) {
    log.warn(`${LOG_PREFIX} v2 migration had ${failed} failed entries — marker withheld, retried next boot`);
    return;
  }
  writeSyncState(paths, {
    ...readSyncState(paths),
    migration: {
      doneAt: now(),
      pulled: outcome.pulled ?? 0,
      deduped: outcome.deduped ?? 0,
      failed: 0,
      entries: outcome.entries,
    },
  });
  log.info(
    `${LOG_PREFIX} v2 migration complete: ${outcome.pulled ?? 0} pulled, ${outcome.deduped ?? 0} already present`
  );
}

// ---------------------------------------------------------------------------
// Run + record — the manual sync button and the auto paths share this.
// ---------------------------------------------------------------------------

export interface SyncRunResult {
  read?: SyncRunOutcome;
  write?: SyncRunOutcome;
}

/** Execute a direction (or both) and persist the outcomes. Never throws. */
export async function runCredentialSync(
  direction: SyncDirectionRequest,
  ocr: CredentialStore,
  overrides: SyncOverrides = {}
): Promise<SyncRunResult> {
  const result: SyncRunResult = {};
  if (direction === 'read' || direction === 'both') {
    result.read = await safeRun(() => pullV2IntoOcr(ocr, overrides));
    recordSyncOutcome('read', result.read, overrides);
  }
  if (direction === 'write' || direction === 'both') {
    result.write = await safeRun(() => pushOcrIntoV2(ocr, overrides));
    recordSyncOutcome('write', result.write, overrides);
  }
  return result;
}

async function safeRun(run: () => Promise<SyncRunOutcome>): Promise<SyncRunOutcome> {
  try {
    return await run();
  } catch (e) {
    return {
      ok: false,
      entries: [],
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Boot engine — one-time migration, auto-read poll, auto-write debounce.
// ---------------------------------------------------------------------------

interface SyncEngine {
  store: CredentialStore;
  overrides: SyncOverrides;
  pollTimer: ReturnType<typeof setInterval> | null;
  writeTimer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  writing: boolean;
}

let engine: SyncEngine | null = null;

/** Boot hook: migration one-shot + auto timers + the OCR mutation hook. */
export async function initCredentialSync(store: CredentialStore, overrides: SyncOverrides = {}): Promise<void> {
  stopCredentialSync();
  engine = { store, overrides, pollTimer: null, writeTimer: null, reading: false, writing: false };

  await maybeRunV2Migration(store, overrides);

  // Auto-write: OCR mutation -> debounced push. The toggle is checked at FIRE
  // time, so toggling off between the mutation and the debounce elapse skips.
  if (store instanceof OcrStore) {
    store.setMutationHook(() => scheduleAutoWrite());
  }

  const pollMs = overrides.autoReadPollMs ?? 60_000;
  engine.pollTimer = setInterval(() => void tickAutoPoll(), pollMs);
  // A pending poll must not hold the process open on shutdown.
  engine.pollTimer.unref?.();
}

/** Stop timers + drop the engine (boot reruns and tests). */
export function stopCredentialSync(): void {
  if (!engine) return;
  if (engine.pollTimer) clearInterval(engine.pollTimer);
  if (engine.writeTimer) clearTimeout(engine.writeTimer);
  engine = null;
}

/**
 * The periodic tick drives BOTH directions:
 *  - autoRead  → pull the client db into the OCR file (periodic read-sync);
 *  - autoWrite → the realtime path is the mutation debounce, and this tick is
 *    its periodic SAFETY NET: a write that failed (service down at mutation
 *    time) or never ran is retried here, so the client converges without a
 *    human noticing. A recorded-ok last write means everything converged —
 *    nothing to do until the next OCR mutation.
 */
async function tickAutoPoll(): Promise<void> {
  if (!engine || engine.reading || engine.writing) return;
  const { store, overrides } = engine;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const client = clientStateOf(readSyncState(paths));
  if (client.autoRead) {
    engine.reading = true;
    try {
      const outcome = await safeRun(() => pullV2IntoOcr(store, overrides));
      recordSyncOutcome('read', outcome, overrides);
    } finally {
      if (engine) engine.reading = false;
    }
  }
  if (client.autoWrite && !engine.writing) {
    // Re-read after the pull: a fresh pull that added keys is exactly the
    // state a lagging write retry should converge (dedup keeps it idempotent).
    const fresh = clientStateOf(readSyncState(paths));
    if (!fresh.lastWrite || !fresh.lastWrite.ok) {
      engine.writing = true;
      try {
        const outcome = await safeRun(() => pushOcrIntoV2(store, overrides));
        recordSyncOutcome('write', outcome, overrides);
      } finally {
        if (engine) engine.writing = false;
      }
    }
  }
}

function scheduleAutoWrite(): void {
  if (!engine) return;
  if (engine.writeTimer) clearTimeout(engine.writeTimer);
  const debounceMs = engine.overrides.writeDebounceMs ?? 1_500;
  engine.writeTimer = setTimeout(() => void tickAutoWrite(), debounceMs);
  engine.writeTimer.unref?.();
}

async function tickAutoWrite(): Promise<void> {
  if (!engine || engine.writing) return;
  const { store, overrides } = engine;
  const client = clientStateOf(readSyncState(overrides.paths ?? resolveDefaultPaths()));
  if (!client.autoWrite) return;
  engine.writing = true;
  if (engine.writeTimer) {
    clearTimeout(engine.writeTimer);
    engine.writeTimer = null;
  }
  try {
    const outcome = await safeRun(() => pushOcrIntoV2(store, overrides));
    recordSyncOutcome('write', outcome, overrides);
  } finally {
    if (engine) engine.writing = false;
  }
}
