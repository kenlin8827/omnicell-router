import { keyHashPrefix } from './types.js';
import type { OpenCodeAuthEntry } from '../user-config.js';
import { CredentialPaths, credentialStoreStateFile, resolveDefaultPaths } from './paths.js';
import { CredentialStore } from './types.js';
import {
  CredentialStoreState,
  CredentialStoreStateReconcile,
  ExcludedCredential,
  ReconcileEntryRecord,
  StoreStatus,
  getBoundCredentialPaths,
  readCredentialStoreState,
  writeCredentialStoreState,
} from './factory.js';
import { AuthSnapshot, authSnapshot } from './auth-snapshot.js';

/**
 * The one-shot reconcile gate (anti-regression).
 *
 * On the FIRST boot that binds a writable OpencodeV2Store with no completion marker:
 * read the auth.json snapshot (opencode-v1 read path via bridge primitives — read
 * only), diff its api-type entries against the opencode v2 db credentials, and push
 * auth.json-only keys through OpencodeV2Store.connectKey (POST …/connect/key).
 * Dedup is keyed by (provider case-insensitive × keyHash prefix — hash
 * primary, label advisory). oauth/wellknown entries are NEVER pushed
 * (the OAuth boundary — reconcile pushes {type:'key'}/api only).
 *
 * auth.json itself is never modified or deleted (opencode's territory).
 * Completing — even with partial push failures — writes the marker + audit
 * trail into <ocrHome>/credential-store.json and sets authWriteDisabled,
 * which B4 gates console auth.json writes on. The gate is idempotent:
 * marker present => zero work; rerunning with the same inputs => zero pushes.
 *
 * Total function: it never throws — a crash lands as an excluded entry and
 * the bind stands (boot must not die here).
 */

const LOG_PREFIX = '[reconcile]';
const PUSH_FAILED_DETAIL = 'push failed, key present locally';

/** Minimal structured sink; routes/boot pass pino-compatible objects (req.log fits). */
export interface ReconcileLogSink {
  info(msg: string): void;
  warn(msg: string): void;
}

// Boot runs before the Fastify instance exists; the repo's boot convention
// is prefixed console lines (index.ts). B4's rebind path can inject req.log.
const defaultLog: ReconcileLogSink = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

export interface EnsureReconciledDeps {
  paths?: CredentialPaths;
  /** auth.json reader seam; defaults to the injected-path bridge (read-only use). */
  bridge?: AuthSnapshot;
  log?: ReconcileLogSink;
  now?: () => number;
}

export interface ReconcileResult {
  ran: boolean;
  skipped?: 'not-opencode-v2' | 'already-done';
  entries: ReconcileEntryRecord[];
  authWriteDisabled: boolean;
}

export async function ensureReconciled(
  store: CredentialStore,
  status: StoreStatus,
  deps: EnsureReconciledDeps = {}
): Promise<ReconcileResult> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? Date.now;
  const paths = deps.paths ?? getBoundCredentialPaths() ?? resolveDefaultPaths();
  try {
    return await runReconcile(store, status, paths, deps.bridge ?? authSnapshot(paths), log, now);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`${LOG_PREFIX} crashed — bind stands, boot continues: ${msg}`);
    status.excluded.push({ provider: '*', reasonCode: 'reconcile_push_failed', detail: `reconcile crashed: ${msg}` });
    return { ran: false, entries: [], authWriteDisabled: isAuthJsonWriteDisabled(paths) };
  }
}

/**
 * In-process override for the Decision 4 gate (P2-6): marker persistence goes
 * through atomicWriteWithRetry best-effort (writeCredentialStoreState swallows
 * a final failure), so a completed reconcile must still count as done FOR THIS
 * BOOT even when the file write failed. The persisted file stays the
 * cross-boot fallback: if the marker never survived, the next boot re-runs the
 * gate — idempotent by keyHash dedup (pushed keys dedup, failed keys retry) —
 * which is strictly safer than silently re-enabling auth.json writes. Keyed by
 * state-file path so sandboxed machines never share an override.
 */
const inProcessAuthWriteDisabled = new Set<string>();

/**
 * Sync read of the Decision 4 gate's B4 seam: true only when the PERSISTED
 * binding is a writable 'opencode-v2' AND the reconcile marker completed (or the
 * marker completed in-process this boot — see override above). Cheap
 * single-file read; no file-state cache — the answer must reflect a
 * just-completed reconcile within the same boot, and it is only consulted on
 * admin credential writes.
 */
export function isAuthJsonWriteDisabled(paths?: CredentialPaths): boolean {
  const p = paths ?? getBoundCredentialPaths() ?? resolveDefaultPaths();
  if (inProcessAuthWriteDisabled.has(credentialStoreStateFile(p))) return true;
  const state = readCredentialStoreState(p);
  return state?.bound === 'opencode-v2' && state?.reconcile?.authWriteDisabled === true;
}

/**
 * B4 parallel flag (NOT folded into isAuthJsonWriteDisabled, which stays the
 * opencode-v2 reconcile gate per Decision 4): true when the standalone one-shot import
 * landed this machine on OcrStore with auth.json entries — from then on
 * auth.json is superseded by <ocrHome>/credentials.json as the OCR-side truth
 * and the console must not side-write it (same anti-double-truth reason).
 */
export function isStandaloneAuthImported(paths?: CredentialPaths): boolean {
  const state = readCredentialStoreState(paths ?? getBoundCredentialPaths() ?? resolveDefaultPaths());
  return state?.bound === 'ocr' && typeof state?.standaloneImport?.doneAt === 'number';
}

/**
 * KeyHash dedup index of a store's current credentials (shared dedup
 * rule: keyHash primary, label advisory). Shared by the reconcile gate and
 * the push endpoint — one guard, two converge-toward-opencode
 * flows. An empty index on throw degrades toward pushing (a duplicate push is
 * louder and safer than skipping real keys); push failures land in results,
 * never silence.
 */
export function indexStoreKeyHashes(
  store: CredentialStore,
  log: ReconcileLogSink = defaultLog
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  try {
    for (const overview of store.accountsOverview()) {
      for (const meta of store.listAccounts(overview.providerId)) {
        if (!meta.keyHashPrefix) continue;
        const bucket = index.get(meta.providerId.toLowerCase());
        if (bucket) bucket.add(meta.keyHashPrefix);
        else index.set(meta.providerId.toLowerCase(), new Set([meta.keyHashPrefix]));
      }
    }
  } catch (e) {
    log.warn(`${LOG_PREFIX} could not index store credentials for dedup: ${e instanceof Error ? e.message : String(e)}`);
  }
  return index;
}

async function runReconcile(
  store: CredentialStore,
  status: StoreStatus,
  paths: CredentialPaths,
  bridge: AuthSnapshot,
  log: ReconcileLogSink,
  now: () => number
): Promise<ReconcileResult> {
  // Decision 1 (P2-8): branch on CAPABILITIES, never on `kind`. The gate
  // needs a store that can push api keys toward the opencode v2 truth —
  // envVisible (coexists with opencode's surface) AND activate (writable
  // per-account semantics) is exactly the writable-OpencodeV2Store signature.
  // opencode-v2-readonly cannot push (writes refused) — the gate waits for a
  // writable bind; other kinds have nothing to converge toward opencode.
  if (!store.capabilities.envVisible || !store.capabilities.activate) {
    return { ran: false, skipped: 'not-opencode-v2', entries: [], authWriteDisabled: false };
  }
  const state = readCredentialStoreState(paths);
  if (state?.reconcile?.doneAt) {
    // Audit honesty (P2-5): the one-shot ran on an earlier
    // boot — failed entries from the persisted audit trail stay STRANDED
    // keys. Without this re-append they vanish after boot #1 (silent). The
    // reason was redacted by construction (http() redacts before the message
    // is built), so it is management-surface safe.
    for (const entry of state.reconcile.entries) {
      if (entry.action !== 'failed') continue;
      const dup = status.excluded.some(
        (e) => e.provider === entry.provider && e.reasonCode === 'reconcile_push_failed'
      );
      if (dup) continue;
      status.excluded.push({
        provider: entry.provider,
        reasonCode: 'reconcile_push_failed',
        detail: `persisted reconcile failure: ${entry.reason ?? PUSH_FAILED_DETAIL}`,
      });
    }
    return {
      ran: false,
      skipped: 'already-done',
      entries: state.reconcile.entries,
      authWriteDisabled: state.reconcile.authWriteDisabled === true,
    };
  }

  // --- read the auth.json snapshot (never write it) ------------------------
  let snapshot: Record<string, OpenCodeAuthEntry>;
  try {
    snapshot = bridge.read();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`${LOG_PREFIX} auth.json snapshot unreadable — nothing to reconcile: ${msg}`);
    status.excluded.push({ provider: '*', reasonCode: 'reconcile_push_failed', detail: `auth.json snapshot unreadable — nothing reconciled: ${msg}` });
    snapshot = {};
  }

  // --- index the db credentials for dedup (keyHash primary) ---------------
  const dbIndex = indexStoreKeyHashes(store, log);

  // --- entry-by-entry converge (push-only toward opencode) -----------------
  const entries: ReconcileEntryRecord[] = [];
  let pushed = 0;
  for (const [providerId, entry] of Object.entries(snapshot)) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.type !== 'api' || // oauth/wellknown never pushed
      typeof entry.key !== 'string' ||
      !entry.key
    ) {
      continue;
    }
    const prefix = keyHashPrefix(entry.key);
    if (dbIndex.get(providerId.toLowerCase())?.has(prefix)) {
      log.info(`${LOG_PREFIX} ${providerId}: deduped (key ${prefix})`);
      entries.push({ provider: providerId, action: 'deduped' });
      continue;
    }
    try {
      await store.connectKey(providerId, entry.key);
      pushed += 1;
      log.info(`${LOG_PREFIX} ${providerId}: pushed (key ${prefix})`);
      entries.push({ provider: providerId, action: 'pushed' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`${LOG_PREFIX} ${providerId}: push failed — ${msg}`);
      entries.push({ provider: providerId, action: 'failed', reason: msg });
      status.excluded.push(excludedPushFailure(providerId));
      // keep going: remaining entries must not be silently dropped
    }
  }

  // Pushed keys must be resolvable THIS boot — drop the cached view.
  if (pushed > 0) store.invalidate();

  const reconcile: CredentialStoreStateReconcile = {
    doneAt: now(),
    authWriteDisabled: true, // even with partial failures: no future auth.json writes on this machine
    entries,
  };
  const base: CredentialStoreState = state ?? {
    bound: store.kind,
    version: null,
    evidence: status.evidence,
    degradedCode: status.degradedCode,
    updatedAt: now(),
  };
  writeCredentialStoreState(paths, { ...base, reconcile });
  // P2-6: the gate completed THIS boot — the override keeps the auth.json
  // write path disabled even if the marker write above failed best-effort.
  inProcessAuthWriteDisabled.add(credentialStoreStateFile(paths));
  log.info(`${LOG_PREFIX} complete: ${pushed} pushed, ${entries.length} entries recorded; auth.json write path disabled`);

  return { ran: true, entries, authWriteDisabled: true };
}

function excludedPushFailure(provider: string): ExcludedCredential {
  return { provider, reasonCode: 'reconcile_push_failed', detail: PUSH_FAILED_DETAIL };
}
