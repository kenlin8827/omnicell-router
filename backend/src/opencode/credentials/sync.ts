import fs from 'node:fs';
import path from 'node:path';
import {
  CredentialPaths,
  credentialSyncFile,
  defaultEnv,
  resolveDefaultPaths,
} from './paths.js';
import { CredentialStore, StoreUnreadableError, keyHashPrefix } from './types.js';
import { DbOpener, OpencodeV2Store, resolveServiceConfigForPaths } from './opencode-v2-store.js';
import { authSnapshot } from './auth-snapshot.js';
import type { OpenCodeAuthEntry } from '../user-config.js';
import { atomicWriteWithRetry } from './factory.js';
import { OcrStore } from './ocr-store.js';

/**
 * Credential sync — per-client credential propagation with the OCR file
 * (<ocrHome>/credentials.json) as the single truth.
 *
 * The bound store is ALWAYS the OcrStore (factory decision). The opencode
 * flavors are SYNC CLIENTS, not alternative truths. Two clients ship by
 * default, both toggles OFF (manual-only until the operator enables them):
 *
 *  - opencode-v2: read pulls the v2 db (readonly sqlite) into the OCR file;
 *    write pushes through the v2 HTTP management API (never raw sqlite).
 *  - opencode-v1: read pulls the legacy auth.json snapshot into the OCR file;
 *    write merges the chain-head api key back into auth.json — api-shaped
 *    entries only, oauth/wellknown entries preserved untouched, one key per
 *    provider (the v1 file shape), no delete propagation.
 *
 * The v1 client is only active on a v1-flavored machine: auth.json present
 * WITHOUT v2 evidence (no opencode.db, no v2 version pin). On a v2 machine
 * auth.json is by definition a stale one-time migration snapshot and is never
 * pulled or written.
 *
 * Write direction invariant for BOTH clients: local OCR entries are KEPT —
 * the push converges the CLIENT toward the OCR file, never the reverse.
 */

export type SyncClientId = 'opencode-v1' | 'opencode-v2';
export type SyncDirection = 'read' | 'write';
export type SyncDirectionRequest = SyncDirection | 'both';

/** The clients OCR can sync with, in table order. Both default to OFF. */
export const SYNC_CLIENTS: ReadonlyArray<{ id: SyncClientId; label: string }> = [
  { id: 'opencode-v2', label: 'OpenCode V2' },
  { id: 'opencode-v1', label: 'OpenCode V1' },
];

export function isSyncClientId(value: unknown): value is SyncClientId {
  return value === 'opencode-v1' || value === 'opencode-v2';
}

export function syncClientLabel(id: SyncClientId): string {
  return SYNC_CLIENTS.find((c) => c.id === id)?.label ?? id;
}

export interface SyncEntryRecord {
  provider: string;
  action: 'pulled' | 'deduped' | 'failed' | 'pushed' | 'skipped';
  reason?: string;
}

/** Machine-readable gate failure for a run that attempted nothing. */
export type SyncPrecondition = 'client_absent' | 'client_unreadable' | 'service_unreachable';

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

function clientStateOf(rec: SyncStateFile, clientId: SyncClientId): ClientSyncState {
  const c = rec.clients[clientId];
  return {
    autoRead: c?.autoRead === true,
    autoWrite: c?.autoWrite === true,
    ...(c?.lastReadAt !== undefined ? { lastReadAt: c.lastReadAt } : {}),
    ...(c?.lastWriteAt !== undefined ? { lastWriteAt: c.lastWriteAt } : {}),
    ...(c?.lastRead ? { lastRead: c.lastRead } : {}),
    ...(c?.lastWrite ? { lastWrite: c.lastWrite } : {}),
  };
}

/** Merge-write one direction's outcome (timestamps + audit) for one client. */
export function recordSyncOutcome(
  clientId: SyncClientId,
  direction: SyncDirection,
  outcome: SyncRunOutcome,
  overrides: SyncOverrides = {}
): ClientSyncState {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const now = overrides.now ?? Date.now;
  const rec = readSyncState(paths);
  const client = clientStateOf(rec, clientId);
  const next: ClientSyncState = {
    ...client,
    ...(direction === 'read'
      ? { lastReadAt: now(), lastRead: outcome }
      : { lastWriteAt: now(), lastWrite: outcome }),
  };
  writeSyncState(paths, { ...rec, clients: { ...rec.clients, [clientId]: next } });
  return next;
}

/** Persist an auto-sync toggle for one client. Returns the updated client state. */
export function setSyncAutoToggle(
  clientId: SyncClientId,
  direction: SyncDirection,
  enabled: boolean,
  overrides: SyncOverrides = {}
): ClientSyncState {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const rec = readSyncState(paths);
  const client = clientStateOf(rec, clientId);
  const next: ClientSyncState = {
    ...client,
    ...(direction === 'read' ? { autoRead: enabled } : { autoWrite: enabled }),
  };
  writeSyncState(paths, { ...rec, clients: { ...rec.clients, [clientId]: next } });
  return next;
}

/** opencode flavor evidence: the version pin's major (diagnostics for the v1 client). */
function installedMajor(paths: CredentialPaths): number | null {
  try {
    const text = fs.readFileSync(paths.installedVersionPath, 'utf8').trim();
    const m = /v?(\d+)\./.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The v1 client only exists where auth.json exists WITHOUT v2 evidence —
 * on a v2 machine auth.json is a stale migration snapshot, never a sync peer.
 */
function v1FlavorActive(paths: CredentialPaths): boolean {
  return fs.existsSync(paths.authJsonPath) && !fs.existsSync(paths.opencodeDbPath) && installedMajor(paths) !== 2;
}

/** Masked status view for the console route — every client, defaults OFF. */
export function credentialSyncStatusView(overrides: SyncOverrides = {}): {
  clients: Array<ClientSyncState & { id: SyncClientId; label: string; present: boolean; writeReady: boolean }>;
} {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();
  const rec = readSyncState(paths);
  return {
    clients: SYNC_CLIENTS.map((c) => {
      let present = false;
      let writeReady = false;
      if (c.id === 'opencode-v1') {
        present = v1FlavorActive(paths);
        writeReady = present; // a local file merge is always possible when the client exists
      } else {
        present = fs.existsSync(paths.opencodeDbPath);
        writeReady = present && Boolean(resolveServiceConfigForPaths(paths, env));
      }
      return { id: c.id, label: c.label, present, writeReady, ...clientStateOf(rec, c.id) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Read sync (pull): client -> OCR file.
// ---------------------------------------------------------------------------

/** opencode v1: pull api-type auth.json entries into the OCR file. */
async function pullV1IntoOcr(ocr: CredentialStore, overrides: SyncOverrides): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  // Flavor guard: on a v2 machine auth.json is a stale migration snapshot —
  // pulling it would silently resurface old credentials.
  if (!v1FlavorActive(paths)) {
    return { ok: false, precondition: 'client_absent', entries: [] };
  }
  let snapshot: Record<string, OpenCodeAuthEntry>;
  try {
    snapshot = authSnapshot(paths).read();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`${LOG_PREFIX} v1 read: auth.json unreadable — ${msg}`);
    return { ok: false, precondition: 'client_unreadable', entries: [], detail: msg };
  }

  const entries: SyncEntryRecord[] = [];
  let pulled = 0;
  let deduped = 0;
  for (const [providerId, entry] of Object.entries(snapshot)) {
    // oauth/wellknown never leave the client (the OAuth boundary) — and unlike
    // the v2 db (whose resolveKeyChain filters them), the snapshot exposes them,
    // so they are skipped here explicitly and silently.
    if (!entry || typeof entry !== 'object') {
      entries.push({ provider: providerId, action: 'failed', reason: 'malformed auth.json entry' });
      continue;
    }
    if (entry.type === 'oauth' || entry.type === 'wellknown') continue;
    if (entry.type !== 'api' || typeof entry.key !== 'string' || !entry.key) {
      entries.push({
        provider: providerId,
        action: 'failed',
        reason: `unusable auth.json entry (type=${String(entry.type)}, key=${typeof entry.key === 'string' ? 'empty' : 'missing'})`,
      });
      continue;
    }
    let localPrefixes: Set<string>;
    try {
      localPrefixes = new Set(
        ocr
          .listCredentials(providerId)
          .map((a) => a.keyHashPrefix ?? '')
          .filter(Boolean)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      entries.push({ provider: providerId, action: 'failed', reason: `local store unreadable: ${msg}` });
      continue;
    }
    const prefix = keyHashPrefix(entry.key);
    if (localPrefixes.has(prefix)) {
      entries.push({ provider: providerId, action: 'deduped' });
      deduped += 1;
      continue;
    }
    try {
      await ocr.connectKey(providerId, entry.key);
      entries.push({ provider: providerId, action: 'pulled' });
      pulled += 1;
      localPrefixes.add(prefix);
      log.info(`${LOG_PREFIX} v1 read: ${providerId} pulled (key ${prefix})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      entries.push({ provider: providerId, action: 'failed', reason: msg });
      log.warn(`${LOG_PREFIX} v1 read: ${providerId} pull failed — ${msg}`);
    }
  }
  return { ok: !entries.some((e) => e.action === 'failed'), pulled, deduped, entries };
}

/** opencode v2: pull routable api rows from the readonly db into the OCR file. */
async function pullV2IntoOcr(ocr: CredentialStore, overrides: SyncOverrides): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();

  if (!fs.existsSync(paths.opencodeDbPath)) {
    return { ok: false, precondition: 'client_absent', entries: [] };
  }
  let v2: OpencodeV2Store;
  try {
    const deps: Parameters<typeof OpencodeV2Store.create>[0] = { paths, writable: false };
    if (overrides.openDatabase) deps.openDatabase = overrides.openDatabase;
    if (overrides.now) deps.now = overrides.now;
    v2 = await OpencodeV2Store.create(deps);
  } catch (e) {
    if (e instanceof StoreUnreadableError) {
      log.warn(`${LOG_PREFIX} v2 read: opencode v2 db unreadable — ${e.message}`);
      return { ok: false, precondition: 'client_unreadable', entries: [], detail: e.message };
    }
    throw e;
  }

  try {
    const entries: SyncEntryRecord[] = [];
    let pulled = 0;
    let deduped = 0;
    for (const overview of v2.credentialsOverview()) {
      const providerId = overview.providerId;
      if (!providerId) continue;
      let localPrefixes: Set<string>;
      try {
        localPrefixes = new Set(
          ocr
            .listCredentials(providerId)
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
          log.info(`${LOG_PREFIX} v2 read: ${providerId} pulled (key ${prefix})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          entries.push({ provider: providerId, action: 'failed', reason: msg });
          log.warn(`${LOG_PREFIX} v2 read: ${providerId} pull failed — ${msg}`);
        }
      }
    }
    return { ok: !entries.some((e) => e.action === 'failed'), pulled, deduped, entries };
  } finally {
    v2.close(); // one transient readonly handle per pull — do not leak it
  }
}

// ---------------------------------------------------------------------------
// Write sync (push): OCR file -> client (local entries KEPT).
// ---------------------------------------------------------------------------

/**
 * opencode v1: merge the chain-head api key of every local provider into
 * auth.json. Rails: api-shaped entries only (an existing oauth/wellknown
 * entry is preserved and reported as skipped), ONE key per provider (the v1
 * file shape — the active head wins), no delete propagation, and the file is
 * never written on a v2-flavored machine (stale snapshot territory).
 */
async function pushOcrIntoV1(
  ocr: CredentialStore,
  overrides: SyncOverrides & { provider?: string }
): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  if (!v1FlavorActive(paths)) {
    return { ok: false, precondition: 'client_absent', entries: [] };
  }
  // Collect + parse BEFORE any write: an unparsable auth.json is refused, never
  // clobbered with a merged rewrite (we could not preserve what we cannot parse).
  let existing: Record<string, OpenCodeAuthEntry>;
  try {
    existing = authSnapshot(paths).read();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`${LOG_PREFIX} v1 write: auth.json unreadable — refusing to merge: ${msg}`);
    return { ok: false, precondition: 'client_unreadable', entries: [], detail: msg };
  }
  const existingKeys = new Map(Object.keys(existing).map((k) => [k.toLowerCase(), k]));

  const providerIds = overrides.provider
    ? [overrides.provider]
    : ocr.credentialsOverview().map((a) => a.providerId);

  const entries: SyncEntryRecord[] = [];
  const pushedKeys: { provider: string; keyHashPrefix: string }[] = [];
  let pushed = 0;
  let deduped = 0;
  const next: Record<string, OpenCodeAuthEntry> = { ...existing };
  for (const providerId of providerIds) {
    const head = ocr.resolveKeyChain(providerId).find((c) => c.key); // active head, routable only
    if (!head) continue; // nothing to push for this provider
    const existingKey = existingKeys.get(providerId.toLowerCase());
    const current = existingKey !== undefined ? existing[existingKey] : undefined;
    if (current && typeof current === 'object' && current.type && current.type !== 'api') {
      // An oauth/wellknown entry holds tokens an api key must not overwrite.
      entries.push({
        provider: providerId,
        action: 'skipped',
        reason: `existing auth.json entry is type '${current.type}' — preserved untouched`,
      });
      continue;
    }
    const prefix = keyHashPrefix(head.key);
    if (current?.type === 'api' && current.key === head.key) {
      entries.push({ provider: providerId, action: 'deduped' });
      deduped += 1;
      pushedKeys.push({ provider: providerId, keyHashPrefix: prefix });
      continue;
    }
    next[existingKey ?? providerId] = { ...(typeof current === 'object' ? current : {}), type: 'api', key: head.key };
    entries.push({ provider: providerId, action: 'pushed' });
    pushed += 1;
    pushedKeys.push({ provider: providerId, keyHashPrefix: prefix });
    log.info(`${LOG_PREFIX} v1 write: ${providerId} pushed (key ${prefix})`);
  }
  if (pushed === 0) {
    return { ok: true, pushed: 0, deduped, entries, pushedKeys };
  }

  // Atomic write into the opencode data dir (the file may not exist yet on a
  // fresh v1 install — creating it is the point of the write).
  try {
    fs.mkdirSync(path.dirname(paths.authJsonPath), { recursive: true });
    const tmp = `${paths.authJsonPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best effort (Windows chmod semantics)
    }
    fs.renameSync(tmp, paths.authJsonPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    entries.push({ provider: overrides.provider ?? '*', action: 'failed', reason: `auth.json write failed: ${msg}` });
    return { ok: false, pushed, deduped, entries, pushedKeys, detail: msg };
  }
  return { ok: !entries.some((e) => e.action === 'failed'), pushed, deduped, entries, pushedKeys };
}

/**
 * opencode v2: push every local api-key credential into the v2 service.
 * Dedup is (provider case-insensitive × keyHash prefix) against the live v2
 * db, so reruns are idempotent. Never throws.
 */
async function pushOcrIntoV2(
  ocr: CredentialStore,
  overrides: SyncOverrides & { provider?: string }
): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();

  // Collect BEFORE the service gate: "nothing to push" is a plain ok even when
  // opencode is down — a manual sync with an empty OCR file must not fake-fail.
  const providerIds = overrides.provider
    ? [overrides.provider]
    : ocr.credentialsOverview().map((a) => a.providerId);
  const local: { cred: ReturnType<CredentialStore['resolveKeyChain']>[number] }[] = [];
  for (const id of providerIds) {
    for (const cred of ocr.resolveKeyChain(id)) local.push({ cred });
  }
  if (local.length === 0) return { ok: true, pushed: 0, deduped: 0, entries: [], pushedKeys: [] };

  if (!resolveServiceConfigForPaths(paths, env)) {
    return { ok: false, precondition: 'service_unreachable', entries: [] };
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
      log.warn(`${LOG_PREFIX} v2 write: opencode v2 db unreadable — ${e.message}`);
      return { ok: false, precondition: 'client_unreadable', entries: [], detail: e.message };
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
        log.info(`${LOG_PREFIX} v2 write: ${cred.providerId} pushed (key ${prefix})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        entries.push({ provider: cred.providerId, action: 'failed', reason: msg });
        log.warn(`${LOG_PREFIX} v2 write: ${cred.providerId} push failed — ${msg}; local entry kept`);
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
    for (const overview of v2.credentialsOverview()) {
      for (const meta of v2.listCredentials(overview.providerId)) {
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
// Client dispatch — the one seam the routes and the engine call through.
// ---------------------------------------------------------------------------

/** Pull one client's credentials into the OCR file. Never throws. */
export async function pullIntoOcr(
  clientId: SyncClientId,
  ocr: CredentialStore,
  overrides: SyncOverrides = {}
): Promise<SyncRunOutcome> {
  try {
    return clientId === 'opencode-v1'
      ? await pullV1IntoOcr(ocr, overrides)
      : await pullV2IntoOcr(ocr, overrides);
  } catch (e) {
    return { ok: false, entries: [], detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Push the OCR file's credentials into one client. Never throws. */
export async function pushFromOcr(
  clientId: SyncClientId,
  ocr: CredentialStore,
  overrides: SyncOverrides & { provider?: string } = {}
): Promise<SyncRunOutcome> {
  try {
    return clientId === 'opencode-v1'
      ? await pushOcrIntoV1(ocr, overrides)
      : await pushOcrIntoV2(ocr, overrides);
  } catch (e) {
    return { ok: false, entries: [], detail: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// One-shot v2 migration — routing continuity for the store flip (v2 only; the
// v1 direction is covered by the standalone import + the continuous pull).
// ---------------------------------------------------------------------------

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
  if (outcome.precondition === 'client_absent') return; // nothing to migrate (yet) — no marker, zero cost
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

/** Execute a direction (or both) for one client and persist the outcomes. Never throws. */
export async function runCredentialSync(
  clientId: SyncClientId,
  direction: SyncDirectionRequest,
  ocr: CredentialStore,
  overrides: SyncOverrides = {}
): Promise<SyncRunResult> {
  const result: SyncRunResult = {};
  if (direction === 'read' || direction === 'both') {
    result.read = await pullIntoOcr(clientId, ocr, overrides);
    recordSyncOutcome(clientId, 'read', result.read, overrides);
  }
  if (direction === 'write' || direction === 'both') {
    result.write = await pushFromOcr(clientId, ocr, overrides);
    recordSyncOutcome(clientId, 'write', result.write, overrides);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Boot engine — one-time migration, auto-read poll, auto-write debounce.
// ---------------------------------------------------------------------------

interface SyncEngine {
  store: CredentialStore;
  overrides: SyncOverrides;
  pollTimer: ReturnType<typeof setInterval> | null;
  writeTimer: ReturnType<typeof setTimeout> | null;
  reading: Set<SyncClientId>;
  writing: Set<SyncClientId>;
}

let engine: SyncEngine | null = null;

/** Boot hook: migration one-shot + auto timers + the OCR mutation hook. */
export async function initCredentialSync(store: CredentialStore, overrides: SyncOverrides = {}): Promise<void> {
  stopCredentialSync();
  engine = {
    store,
    overrides,
    pollTimer: null,
    writeTimer: null,
    reading: new Set(),
    writing: new Set(),
  };

  await maybeRunV2Migration(store, overrides);

  // Auto-write: OCR mutation -> debounced push (every client with the toggle
  // on, checked at FIRE time so toggling off mid-debounce skips).
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
 * The periodic tick drives BOTH directions for EVERY client:
 *  - autoRead  → pull the client's credentials into the OCR file (periodic read-sync);
 *  - autoWrite → the realtime path is the mutation debounce, and this tick is
 *    its periodic SAFETY NET: a write that failed (service down at mutation
 *    time) or never ran is retried here, so the client converges without a
 *    human noticing. A recorded-ok last write means everything converged —
 *    nothing to do until the next OCR mutation.
 */
async function tickAutoPoll(): Promise<void> {
  if (!engine) return;
  const { store, overrides } = engine;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const rec = readSyncState(paths);
  for (const client of SYNC_CLIENTS) {
    const state = clientStateOf(rec, client.id);
    if (state.autoRead && !engine.reading.has(client.id)) {
      engine.reading.add(client.id);
      void pullIntoOcr(client.id, store, overrides)
        .then((outcome) => recordSyncOutcome(client.id, 'read', outcome, overrides))
        .catch(() => undefined)
        .finally(() => {
          if (engine) engine.reading.delete(client.id);
        });
    }
    if (state.autoWrite && !engine.writing.has(client.id)) {
      // Re-read per client: a fresh pull that added keys is exactly the state a
      // lagging write retry should converge (dedup keeps it idempotent).
      const fresh = clientStateOf(readSyncState(paths), client.id);
      if (!fresh.lastWrite || !fresh.lastWrite.ok) {
        engine.writing.add(client.id);
        void pushFromOcr(client.id, store, overrides)
          .then((outcome) => recordSyncOutcome(client.id, 'write', outcome, overrides))
          .catch(() => undefined)
          .finally(() => {
            if (engine) engine.writing.delete(client.id);
          });
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

/** The realtime auto-write path: push to EVERY client whose toggle is on. */
async function tickAutoWrite(): Promise<void> {
  if (!engine) return;
  const { store, overrides } = engine;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const rec = readSyncState(paths);
  for (const client of SYNC_CLIENTS) {
    const state = clientStateOf(rec, client.id);
    if (!state.autoWrite || engine.writing.has(client.id)) continue;
    engine.writing.add(client.id);
    void pushFromOcr(client.id, store, overrides)
      .then((outcome) => recordSyncOutcome(client.id, 'write', outcome, overrides))
      .catch(() => undefined)
      .finally(() => {
        if (engine) engine.writing.delete(client.id);
      });
  }
}
