import fs from 'node:fs';
import {
  CredentialPaths,
  credentialSyncFile,
  defaultEnv,
  isV1ClientPresent,
  resolveDefaultPaths,
  type OpencodeFlavor,
  resolveOpencodeConfigPath,
} from './paths.js';
import { CredentialStore, StoreUnreadableError, keyHashPrefix } from './types.js';
import {
  DbOpener,
  OpencodeV2Store,
  fetchClientDefinedProviderIds,
  reloadOpencodeService,
  resolveServiceConfigForPaths,
} from './opencode-v2-store.js';
import { authSnapshot } from './auth-snapshot.js';
import type { OpenCodeAuthEntry } from './auth-snapshot.js';
import { atomicWriteWithRetry } from './factory.js';
import { OcrStore } from './ocr-store.js';
import { defsRenderChanged, materializeDefs } from './def-materialize.js';
import { importProviderDefsFromClient, setProviderDefsMutationHook, readProviderDefsFile } from '../provider-defs.js';
import { readJsonc } from '../user-config.js';
import { clientDefNodes } from '../provider-def-adapters.js';

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
 * The v1 client is only active on a v1-flavored machine: NO v2 evidence (no
 * opencode.db, no v2 version pin) plus v1 evidence — auth.json OR a v1 version
 * pin, so a fresh v1 install (pin, no auth.json yet) can still be seeded. On a
 * v2 machine auth.json is by definition a stale one-time migration snapshot and
 * is never pulled or written.
 *
 * Write direction invariant for BOTH clients: local OCR entries are KEPT —
 * the push converges the CLIENT toward the OCR file, never the reverse.
 */

/** A sync client IS a client flavor: one union, not a look-alike twin of it. */
export type SyncClientId = OpencodeFlavor;
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
  /** read runs only — provider defs imported from the client config (add-only). */
  defsImported?: number;
  /** read runs only — of `defsImported`, nodes migrated from a retired shape. */
  defsConverted?: number;
  /** read runs only — client nodes already owned by the OCR defs file. */
  defsSkipped?: number;
  /** read runs only — client nodes the importer refused (reported in `entries`). */
  defsFailed?: number;
  /** write runs only — (provider, keyHashPrefix) pairs that converged (SUSPECT lift). */
  pushedKeys?: { provider: string; keyHashPrefix: string }[];
  /** write runs only — provider nodes rendered into the client's providers slot. */
  defsMaterialized?: number;
  /** write runs only — the client slot was actually rewritten (not merely re-rendered). */
  defsChanged?: boolean;
  /** write runs only — a CHANGED render was followed by a service reload that landed. */
  defsReloaded?: boolean;
  /**
   * write runs only — defs LEFT OUT of the client config because the client
   * defines that provider itself (built-in ⇒ keys only, no config node). Recorded
   * so the drift badge compares the render set the last push actually used.
   */
  defsSkippedBuiltIn?: string[];
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
  /**
   * Narrow a run to ONE provider id. Applies to BOTH directions (per-provider
   * push AND pull): the console's provider-scoped gestures must not sweep the
   * whole book. Absent = every provider.
   */
  provider?: string;
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

/** Masked status view for the console route — every client, defaults OFF. */
export function credentialSyncStatusView(overrides: SyncOverrides = {}): {
  clients: Array<
    ClientSyncState & { id: SyncClientId; label: string; present: boolean; writeReady: boolean; defsDrift?: boolean }
  >;
} {
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();
  const rec = readSyncState(paths);
  return {
    clients: SYNC_CLIENTS.map((c) => {
      let present = false;
      let writeReady = false;
      if (c.id === 'opencode-v1') {
        present = isV1ClientPresent(paths);
        // A local file merge (or creation, on a pin-only fresh install) is
        // always possible when the client exists.
        writeReady = present;
      } else {
        present = fs.existsSync(paths.opencodeDbPath);
        writeReady = present && Boolean(resolveServiceConfigForPaths(paths, env));
      }
      const drift = c.id === 'opencode-v2' ? clientDefsDrift(paths, recordedSkippedBuiltIn(rec, c.id)) : undefined;
      return {
        id: c.id,
        label: c.label,
        present,
        writeReady,
        ...(drift !== undefined ? { defsDrift: drift } : {}),
        ...clientStateOf(rec, c.id),
      };
    }),
  };
}

/**
 * Is the client's materialized `providers` slot behind the defs book?
 *
 * Decided by `defsRenderChanged` — the exact comparison the materializer uses to
 * decide whether to write, so the badge can never disagree with what a push
 * would do.
 * `undefined` = no defs book / unreadable client config (nothing to compare).
 * A synced client costs two file reads; a drifted one is exactly the state an
 * operator needs to see (auto-write OFF is the shipped default and the two
 * directions are independent, so silent drift is normal otherwise).
 */
function clientDefsDrift(paths: CredentialPaths, skippedBuiltIn: readonly string[]): boolean | undefined {
  try {
    const defs = readProviderDefsFile(paths);
    if (!defs) return undefined;
    const configPath = resolveOpencodeConfigPath(paths);
    const parsed = fs.existsSync(configPath) ? readJsonc(configPath) : undefined;
    if (fs.existsSync(configPath) && parsed === undefined) return undefined; // unparsable: no comparison
    return defsRenderChanged(clientDefNodes(parsed), defs.providers, skippedBuiltIn);
  } catch {
    return undefined;
  }
}

/**
 * The built-in ids the last write run left to the client's own catalog. The badge
 * must compare the SAME render set that push used, and the set is evidence from
 * the running service (not re-derivable from files), so the recorded run is the
 * source. No run yet ⇒ nothing was skipped ⇒ compare the whole book.
 */
function recordedSkippedBuiltIn(rec: SyncStateFile, clientId: SyncClientId): string[] {
  return rec.clients[clientId]?.lastWrite?.defsSkippedBuiltIn ?? [];
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
  if (!isV1ClientPresent(paths)) {
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
  const only = overrides.provider?.toLowerCase();
  for (const [providerId, entry] of Object.entries(snapshot)) {
    if (only && providerId.toLowerCase() !== only) continue; // narrowed run
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
          .map((c) => c.keyHashPrefix ?? '')
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
  return withImportedClientDefs(
    { ok: !entries.some((e) => e.action === 'failed'), pulled, deduped, entries },
    paths,
    'opencode-v1',
    only,
    log
  );
}

/**
 * The provider-defs half of a READ run: import the client config through the
 * adapter for THIS client's flavor. The version is never guessed — a manual or
 * auto "sync opencode v2" always runs the v2 adapter (`providers` canonical
 * only — the retired singular slot is never read), and an opencode-v1 run
 * always runs the v1 adapter (`provider` only, its own node spelling). Add-only: the OCR defs file
 * stays the truth, so a re-run costs nothing and never rewrites an operator's def.
 */
function withImportedClientDefs(
  outcome: SyncRunOutcome,
  paths: CredentialPaths,
  flavor: SyncClientId,
  onlyProvider: string | undefined,
  log: SyncLogSink
): SyncRunOutcome {
  const result = importProviderDefsFromClient({
    paths,
    flavor,
    ...(onlyProvider ? { onlyProvider } : {}),
  });
  const hardFailure = result.retryOnNextBoot || result.failed > 0;
  if (result.imported > 0 || hardFailure) {
    log.warn(
      `${LOG_PREFIX} ${flavor} read: provider import — ${result.imported} imported (${result.converted} converted), ` +
        `${result.skipped} skipped, ${result.failed} failed${result.detail ? `: ${result.detail}` : ''}`
    );
  }
  const failures = result.entries
    .filter((e) => e.action === 'failed')
    .map((e) => `${e.provider} (${e.reason})`)
    .join('; ');
  return {
    ...outcome,
    ok: outcome.ok && !hardFailure,
    entries: hardFailure
      ? [...outcome.entries, { provider: '*', action: 'failed', reason: `provider import: ${failures || result.detail || 'failed'}` }]
      : outcome.entries,
    defsImported: result.imported,
    defsConverted: result.converted,
    defsSkipped: result.skipped,
    defsFailed: result.failed,
  };
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
    const only = overrides.provider?.toLowerCase();
    for (const overview of v2.credentialsOverview()) {
      const providerId = overview.providerId;
      if (!providerId) continue;
      if (only && providerId.toLowerCase() !== only) continue; // narrowed run
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
      const chain = v2.resolveKeyChain(providerId);
      for (const cred of chain) {
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

      // Chain-head authority runs the OTHER way on the pull: the OCR file is the
      // single truth (the push converges the client toward it), so an existing
      // OCR head is NEVER overwritten here — that would make a pull undo the
      // operator's "set as chain head" whenever auto-write is off, the classic
      // two-directions-fight. The client's head only fills a VOID: a provider
      // whose OCR rows all lost their active flag (the head row was
      // disconnected) adopts the client's head instead of leaving routing on
      // recency alone. An empty provider already lands its first pulled row
      // active, so this is a no-op in the common case.
      const clientHead = chain.find((c) => c.active);
      if (clientHead && ocr.capabilities.activate) {
        try {
          const rows = ocr.listCredentials(providerId);
          if (!rows.some((r) => r.active && r.routable)) {
            const target = rows.find((r) => r.routable && r.keyHashPrefix === keyHashPrefix(clientHead.key));
            if (target) await ocr.activate(target.id);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          entries.push({ provider: providerId, action: 'failed', reason: `active head adoption failed: ${msg}` });
          log.warn(`${LOG_PREFIX} v2 read: ${providerId} active head adoption failed — ${msg}`);
        }
      }
    }
    return withImportedClientDefs(
      { ok: !entries.some((e) => e.action === 'failed'), pulled, deduped, entries },
      paths,
      'opencode-v2',
      overrides.provider,
      log
    );
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
async function pushOcrIntoV1(ocr: CredentialStore, overrides: SyncOverrides): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  if (!isV1ClientPresent(paths)) {
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

  // Backup + atomic write into the opencode data dir (the file may not exist yet
  // on a fresh v1 install; creating it is the point of the write).
  //
  // Two Windows-era lessons applied here, the same ones the defs materializer
  // follows: (a) the pre-write copy is preserved as `<auth.json>.bak.ocr` before
  // every converging write; this file holds ANOTHER process's credentials, so a
  // merge mistake must be recoverable; (b) the rename goes through
  // `atomicWriteWithRetry`, because a security tool holding the file makes the
  // first rename fail with EPERM/EBUSY for a few milliseconds (a raw
  // `renameSync` reports that as a hard write failure).
  try {
    fs.copyFileSync(paths.authJsonPath, `${paths.authJsonPath}.bak.ocr`);
    // copyFileSync lands the copy with umask defaults (0644 on POSIX) — the
    // backup holds the SAME key material as auth.json, so it gets the same
    // 0600 owner-only mode the file itself is given below. Best-effort like
    // every chmod here (Windows semantics are advisory).
    fs.chmodSync(`${paths.authJsonPath}.bak.ocr`, 0o600);
  } catch {
    // fresh v1 install: nothing to preserve yet
  }
  try {
    atomicWriteWithRetry(paths.authJsonPath, `${JSON.stringify(next, null, 2)}\n`);
    try {
      fs.chmodSync(paths.authJsonPath, 0o600);
    } catch {
      // best effort (Windows chmod semantics)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    entries.push({ provider: overrides.provider ?? '*', action: 'failed', reason: `auth.json write failed: ${msg}` });
    return { ok: false, pushed, deduped, entries, pushedKeys, detail: msg };
  }
  return { ok: !entries.some((e) => e.action === 'failed'), pushed, deduped, entries, pushedKeys };
}

/**
 * opencode v2: push the OCR file's state into the v2 service — the def half
 * (materialize the defs file into the client's `providers` slot, REPLACE) runs
 * FIRST and gated on the v2 client being present (db on disk); the key half
 * follows through the HTTP management API. Dedup is (provider
 * case-insensitive × keyHash prefix) against the live v2 db, so reruns are
 * idempotent. Never throws.
 */
async function pushOcrIntoV2(ocr: CredentialStore, overrides: SyncOverrides): Promise<SyncRunOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();

  // Collect BEFORE any gate: "nothing to push" is a plain ok even when
  // opencode is down — a manual sync with an empty OCR file must not fake-fail.
  const providerIds = overrides.provider
    ? [overrides.provider]
    : ocr.credentialsOverview().map((a) => a.providerId);
  // Keys are collected per provider, in CHAIN order (the active head first,
  // then the fallbacks), because the write path must restore the client's
  // active credential to the OCR head after the keys land (see below).
  const chains = providerIds
    .map((id) => ({ id, chain: ocr.resolveKeyChain(id) }))
    .filter((g) => g.chain.length > 0);

  // Def materialization — converge the client's `providers` slot BEFORE any
  // key push, so a brand-new custom provider's id is registered (via the
  // resolveIntegrationId reload self-heal reading the freshly rendered jsonc)
  // by the time its first key pushes. Gated on the v2 client being present
  // (db on disk): a machine without one gains no jsonc providers slot from the
  // v2 client's write path. Runs even with zero keys to push — an emptied defs
  // map must still REPLACE the client slot (def delete propagation).
  //
  // A CHANGED render reloads immediately: the service registers config-declared
  // providers only when it loads config, and a def-only change (new model, price
  // edit, provider delete) pushes no key, so the unmatched-resolve self-heal
  // would never fire — the client would serve stale defs until a restart
  // (ADR-0010 §5 requires the reload; it is not merely an optimization).
  let defsMaterialized: number | undefined;
  let defsChanged: boolean | undefined;
  let defsReloaded: boolean | undefined;
  let defsSkippedBuiltIn: string[] | undefined;
  if (fs.existsSync(paths.opencodeDbPath)) {
    // Built-in ids get keys only; only the client's own catalog answers which
    // those are. An unavailable service (undefined) writes the whole book — a
    // missing def breaks routing, a redundant one never does.
    const clientDefinedIds = await fetchClientDefinedProviderIds(paths, env, {
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    });
    const mat = materializeDefs(paths, undefined, { ...(clientDefinedIds ? { clientDefinedIds } : {}) });
    if (!mat.ok) {
      return {
        ok: false,
        entries: [
          {
            provider: overrides.provider ?? '*',
            action: 'failed',
            reason: `def materialization failed: ${mat.detail}`,
          },
        ],
        detail: mat.detail,
      };
    }
    defsMaterialized = mat.rendered;
    defsChanged = mat.changed;
    defsSkippedBuiltIn = mat.skippedBuiltIn;
    if (mat.changed) {
      const reloadDeps = overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {};
      defsReloaded = await reloadOpencodeService(paths, env, reloadDeps);
      if (!defsReloaded) {
        log.warn(
          `${LOG_PREFIX} v2 write: defs changed but the service reload did not land — the unmatched-write self-heal will retry on the next key push`
        );
      }
    }
  }
  const defsFields = {
    ...(defsMaterialized !== undefined ? { defsMaterialized } : {}),
    ...(defsChanged !== undefined ? { defsChanged } : {}),
    ...(defsReloaded !== undefined ? { defsReloaded } : {}),
    ...(defsSkippedBuiltIn !== undefined ? { defsSkippedBuiltIn } : {}),
  };

  if (chains.length === 0) {
    return {
      ok: true,
      pushed: 0,
      deduped: 0,
      entries: [],
      pushedKeys: [],
      ...defsFields,
    };
  }

  if (!resolveServiceConfigForPaths(paths, env)) {
    return {
      ok: false,
      precondition: 'service_unreachable',
      entries: [],
      ...defsFields,
    };
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
    for (const { id, chain } of chains) {
      const bucket = index.get(id.toLowerCase());
      for (const cred of chain) {
        const prefix = keyHashPrefix(cred.key);
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

      // Active-head authority (the mirror of the console connect route's
      // `headPreserved` defense). opencode v2 makes a freshly connected
      // credential the ACTIVE one (verified live on 2.0.15: adding a second
      // key demotes the working row) and has no credential ordering beyond
      // `active` — so pushing a newly added FALLBACK key would silently
      // re-point the client at it while OCR keeps routing the chain head. The
      // head is therefore re-activated after the provider's keys have landed,
      // every run (deduped keys included): a client whose active row drifted is
      // self-healed by the next push, and an already-correct head costs one
      // view read and no HTTP call.
      const head = chain[0];
      if (!head?.active || !v2.capabilities.activate) continue;
      const headPrefix = keyHashPrefix(head.key);
      try {
        const rows = v2.listCredentials(id);
        if (rows.find((r) => r.active)?.keyHashPrefix !== headPrefix) {
          const target = rows.find((r) => r.routable && r.keyHashPrefix === headPrefix);
          if (target) {
            await v2.activate(target.id);
            log.info(`${LOG_PREFIX} v2 write: ${id} active chain head restored (key ${headPrefix})`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        entries.push({ provider: id, action: 'failed', reason: `active head alignment failed: ${msg}` });
        log.warn(`${LOG_PREFIX} v2 write: ${id} active head alignment failed — ${msg}`);
      }
    }
    return {
      ok: !entries.some((e) => e.action === 'failed'),
      pushed,
      deduped,
      entries,
      pushedKeys,
      ...defsFields,
    };
  } finally {
    v2.close();
  }
}

/**
 * Delete ONE credential on the client — the client half of an operator delete
 * (`DELETE` in the console). Deliberately NOT a set reconciliation: the caller
 * names the exact key material (keyHashPrefix) that must stop existing on the
 * client, and only the matching row is deleted. A diff of "OCR keys vs client
 * keys" is the destructive pattern that must never exist here (an unreadable or
 * degraded book would look like "delete everything").
 *
 * v2 only: the service exposes `DELETE /api/credential/:id`. v1 keeps one key
 * per provider in a plain file with no id-addressed delete, so the answer is
 * `unsupported` and the operator removes the provider entry there.
 *
 * Never throws — the local delete already happened by the time this runs, and a
 * partial result must be reported, not raised.
 */
export interface ClientRevokeOutcome {
  clientId: SyncClientId;
  result: 'deleted' | 'not_found' | 'unsupported' | 'absent' | 'failed';
  detail?: string;
}

export async function revokeOnClient(
  providerId: string,
  keyHashPrefix: string,
  overrides: SyncOverrides = {}
): Promise<ClientRevokeOutcome> {
  const log = overrides.log ?? defaultLog;
  const paths = overrides.paths ?? resolveDefaultPaths();
  const env = overrides.env ?? defaultEnv();

  if (!fs.existsSync(paths.opencodeDbPath)) {
    // No v2 client on this machine. A v1 install has no id-addressed delete.
    return { clientId: 'opencode-v1', result: isV1ClientPresent(paths) ? 'unsupported' : 'absent' };
  }
  let v2: OpencodeV2Store;
  try {
    const deps: Parameters<typeof OpencodeV2Store.create>[0] = { paths, writable: true, env };
    if (overrides.fetchImpl) deps.fetchImpl = overrides.fetchImpl;
    if (overrides.now) deps.now = overrides.now;
    if (overrides.openDatabase) deps.openDatabase = overrides.openDatabase;
    v2 = await OpencodeV2Store.create(deps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`${LOG_PREFIX} client revoke: opencode v2 store unreadable — ${msg}`);
    return { clientId: 'opencode-v2', result: 'failed', detail: msg };
  }
  try {
    let match: { id: string } | undefined;
    try {
      match = v2.listCredentials(providerId).find((c) => c.keyHashPrefix === keyHashPrefix);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { clientId: 'opencode-v2', result: 'failed', detail: msg };
    }
    if (!match) return { clientId: 'opencode-v2', result: 'not_found' };
    try {
      await v2.disconnect(match.id);
      log.info(`${LOG_PREFIX} client revoke: ${providerId} deleted on opencode-v2 (key ${keyHashPrefix})`);
      return { clientId: 'opencode-v2', result: 'deleted' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`${LOG_PREFIX} client revoke: ${providerId} delete failed on opencode-v2 — ${msg}`);
      return { clientId: 'opencode-v2', result: 'failed', detail: msg };
    }
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
  overrides: SyncOverrides = {}
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
  // Def mutations (console CRUD, hook setup/teardown, the one-shot import) fire
  // the same debounced write — defs converge to clients through the
  // materialize step inside the v2 write path.
  setProviderDefsMutationHook(() => scheduleAutoWrite());

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
  setProviderDefsMutationHook(null);
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
      const retryable = shouldRetryAutoWrite(fresh.lastWrite);
      if (retryable) {
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

/**
 * Does the periodic safety net re-run the write for this client?
 *
 * Retries self-healing failures only: no previous run, a missing precondition
 * (service down) or per-entry failures. `client_absent` / `client_unreadable` do
 * not heal by themselves — retrying them every tick would just churn the state
 * file (the toggle row shows them; the operator fixes those).
 *
 * Also retries when the DEFS half did not land: a changed render whose reload
 * failed leaves the client serving a stale provider list, and the key entries
 * were fine (all deduped), so `ok` reads true and nothing else would ever retry
 * it. Key pushes are idempotent, so the re-run is cheap.
 */
export function shouldRetryAutoWrite(lastWrite: SyncRunOutcome | undefined): boolean {
  if (!lastWrite) return true;
  if (lastWrite.defsChanged === true && lastWrite.defsReloaded === false) return true;
  return !lastWrite.ok && (!lastWrite.precondition || lastWrite.precondition === 'service_unreachable');
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
