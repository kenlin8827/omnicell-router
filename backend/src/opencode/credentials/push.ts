import { CredentialPaths, defaultEnv, resolveDefaultPaths } from './paths.js';
import { CredentialStore, RawCred, keyHashPrefix } from './types.js';
import { StoreUnreadableError } from './types.js';
import { DbOpener, OpencodeV2Store, OpencodeV2StoreDeps, resolveServiceConfigForPaths } from './opencode-v2-store.js';
import { indexStoreKeyHashes, ReconcileLogSink } from './reconcile.js';

/**
 * The one-shot **Push to opencode**.
 *
 * When OCR lands on OcrStore (standalone, or the badged db_unreadable
 * degraded binding) it accumulates local entries that opencode never saw.
 * On recovery (opencode v2 service reachable NOW), converge them toward opencode —
 * push-ONLY, the single-truth direction. Per local entry:
 *  1. dedup against the current opencode v2 db via the shared dedup rule
 *     (integration/provider + label advisory + keyHash primary);
 *  2. push what's missing through a FRESH writable OpencodeV2Store (HTTP connect/key
 *     sink — never raw sqlite writes);
 *  3. on CONFIRMED convergence (pushed, or already present by keyHash) remove
 *     the local OcrStore entry — the key has now converged INTO opencode and
 *     the single truth is restored. A failed push keeps the local copy (never
 *     lose data); the removal itself is logged.
 *
 * Raw-key note: `resolveKeyChain` is boot/pool-rebuild-only per types.ts —
 * this push is the one other sanctioned consumer: convergence must read the
 * LOCAL raw keys and hand them TO opencode (which can never export keys
 * back). Nothing that leaves this module carries key material: the response
 * is provider ids + reasons only.
 */

const LOG_PREFIX = '[push]';

const defaultLog: ReconcileLogSink = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

export type PushPrecondition = 'not_ocr_bound' | 'opencode_v2_service_unreachable' | 'opencode_v2_db_unreadable';

export interface PushOutcome {
  /** set instead of attempting anything when the endpoint's gate fails. */
  precondition?: PushPrecondition;
  /** provider ids fully converged (pushed or deduped AND local entry removed). */
  pushed: string[];
  /**
   * Converged (provider, keyHashPrefix) pairs — consumers need the
   * key identity per KEY (a push of a new key is a reconnect and lifts
   * that account's SUSPECT flag; provider ids alone cannot name the account).
   */
  pushedKeys: { provider: string; keyHashPrefix: string }[];
  /** per-entry failures; the local copy of each is KEPT (never blind-delete). */
  failed: { provider: string; reason: string }[];
}

export interface PushDeps {
  /** the bound store — precondition + local entries + removals. */
  store: CredentialStore;
  paths?: CredentialPaths;
  /** absent = every provider with local entries. */
  provider?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  openDatabase?: DbOpener;
  log?: ReconcileLogSink;
}

export async function pushLocalCredentialsToV2(deps: PushDeps): Promise<PushOutcome> {
  const log = deps.log ?? defaultLog;
  const paths = deps.paths ?? resolveDefaultPaths();
  const env = deps.env ?? defaultEnv();
  const store = deps.store;

  // Precondition: only the OCR-owned store holds local leftovers. An opencode v2
  // binding means opencode's own files ARE the truth already — nothing to
  // converge (capability branch: envVisible false ⇔ OcrStore).
  if (store.capabilities.envVisible) {
    return { precondition: 'not_ocr_bound', pushed: [], pushedKeys: [], failed: [] };
  }

  const providerIds = deps.provider ? [deps.provider] : store.accountsOverview().map((a) => a.providerId);
  const local: RawCred[] = [];
  for (const id of providerIds) local.push(...store.resolveKeyChain(id));
  if (local.length === 0) return { pushed: [], pushedKeys: [], failed: [] };

  // "a OpencodeV2Store is reachable NOW": service discovery first (fail fast, no db
  // open), then the readonly db handle the credential view needs for dedup.
  if (!resolveServiceConfigForPaths(paths, env)) {
    return { precondition: 'opencode_v2_service_unreachable', pushed: [], pushedKeys: [], failed: [] };
  }
  let opencodeV2: OpencodeV2Store;
  try {
    const createDeps: OpencodeV2StoreDeps = { paths, writable: true, env };
    if (deps.fetchImpl) createDeps.fetchImpl = deps.fetchImpl;
    if (deps.now) createDeps.now = deps.now;
    if (deps.openDatabase) createDeps.openDatabase = deps.openDatabase;
    opencodeV2 = await OpencodeV2Store.create(createDeps);
  } catch (e) {
    if (e instanceof StoreUnreadableError) {
      return { precondition: 'opencode_v2_db_unreadable', pushed: [], pushedKeys: [], failed: [] };
    }
    throw e;
  }

  try {
    const index = indexStoreKeyHashes(opencodeV2, log);
    const pushed = new Set<string>();
    const pushedKeys: PushOutcome['pushedKeys'] = [];
    const failed: PushOutcome['failed'] = [];
    for (const cred of local) {
      const prefix = keyHashPrefix(cred.key);
      const bucket = index.get(cred.providerId.toLowerCase());
      if (bucket?.has(prefix)) {
        log.info(`${LOG_PREFIX} ${cred.providerId}: already in opencode (key ${prefix}) — local entry removed`);
      } else {
        try {
          await opencodeV2.connectKey(cred.providerId, cred.key, cred.label);
          log.info(`${LOG_PREFIX} ${cred.providerId}: pushed (key ${prefix})`);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          log.warn(`${LOG_PREFIX} ${cred.providerId}: push failed — ${reason}; local entry kept`);
          failed.push({ provider: cred.providerId, reason });
          continue;
        }
      }
      // Confirmed convergence — remove the local copy (single truth restored).
      try {
        await store.disconnect(cred.accountId);
        store.invalidate();
        pushed.add(cred.providerId);
        // Account-level identity for the route's SUSPECT clear (Decision 6:
        // "cleared only by manual reconnect or Push" — this converged entry is
        // exactly that gesture for this key material, deduped or freshly sent).
        pushedKeys.push({ provider: cred.providerId, keyHashPrefix: prefix });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        log.warn(`${LOG_PREFIX} ${cred.providerId}: local removal failed after push — ${reason}`);
        failed.push({ provider: cred.providerId, reason: `pushed to opencode but local entry not removed: ${reason}` });
      }
    }
    return { pushed: [...pushed], pushedKeys, failed };
  } finally {
    opencodeV2.close(); // one transient readonly handle per push — do not leak it
  }
}
