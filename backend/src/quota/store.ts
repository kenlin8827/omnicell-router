import fs from 'node:fs';
import path from 'node:path';
import {
  CredentialPaths,
  resolveDefaultPaths,
  quotaSnapshotsFile,
} from '../opencode/credentials/paths.js';
import type { QuotaBadgeState, QuotaSnapshot, QuotaProbeFailure, LastProbeCapture } from './types.js';
import { renameWithRetry } from '../utils/atomic-write.js';

/**
 * The (provider × keyHashPrefix) quota snapshot store.
 *
 * Snapshots are credential-anchored display-safe aggregates (window numbers,
 * prefixes, plan labels — never key material), so they follow the GLOBAL
 * state root like the SUSPECT/DISABLED flags: an
 * credential's quota history belongs to the credential, not to a book-set.
 *
 * Persistence: atomic temp+rename 0600 with a debounce (the prober writes in
 * bursts; the file is a cold-boot badge seed, not a hot ledger). Load-once:
 * a missing or malformed file starts empty and the first write preserves an
 * unparseable original aside (`.corrupt.<ts>`), same discipline as every
 * other durable state in this repo.
 */

export function quotaPairId(providerId: string, keyHashPrefix: string): string {
  return `${providerId}#${keyHashPrefix}`;
}

interface QuotaFile {
  version: 1;
  snapshots: Record<string, QuotaSnapshot>;
  /** Failure records, keyed like snapshots — additive, absent in older files
   *  (a pair that never succeeded has no snapshot to hang one on). */
  failures?: Record<string, QuotaProbeFailure>;
}

export interface QuotaStoreDeps {
  /** Injection seam for tests — same CredentialPaths the stores use. */
  paths?: CredentialPaths;
  now?: () => number;
}

export class QuotaSnapshotStore {
  private readonly paths: CredentialPaths | undefined;
  private readonly nowFn: () => number;
  private loaded = false;
  private resolvedFile: string | undefined;
  private snapshots = new Map<string, QuotaSnapshot>();
  /** Why the last attempt produced nothing — kept OUTSIDE the snapshot so a
   *  pair that never succeeded still carries its verdict (a snapshot is a
   *  value; a failure is not a value with windows). */
  private failures = new Map<string, QuotaProbeFailure>();
  private preserveCorrupt = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: QuotaStoreDeps = {}) {
    this.paths = deps.paths;
    this.nowFn = deps.now ?? Date.now;
  }

  /** Where snapshots live — log/diagnostic surface, never a secret. */
  public get filePath(): string {
    if (!this.resolvedFile) this.resolvedFile = quotaSnapshotsFile(this.paths ?? resolveDefaultPaths());
    return this.resolvedFile;
  }

  // ─── Last-probe raw capture (memory-only side table) ──────────────────────

  private readonly lastHttp = new Map<string, LastProbeCapture>();

  /** Record the latest raw exchange for a pair (ring of one). NEVER
   *  serialized — the snapshot file stays a cold-boot badge seed. */
  public recordHttp(pairId: string, http: LastProbeCapture): void {
    this.lastHttp.set(pairId, http);
  }

  /** The last raw exchange for a pair, or undefined (memory-only: a fresh
   *  process has none until its next probe). */
  public getLastHttp(pairId: string): LastProbeCapture | undefined {
    return this.lastHttp.get(pairId);
  }

  /** Load-once; a missing or malformed file is an empty set (never fatal). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // absent/unreadable -> no snapshots
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.preserveCorrupt = true;
      console.warn(
        `[quota] ${this.filePath} is unparseable, starting empty: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    const file = parsed as Partial<QuotaFile>;
    if (file.version !== 1 || !file.snapshots || typeof file.snapshots !== 'object') {
      this.preserveCorrupt = true;
      console.warn(`[quota] ${this.filePath} has an unexpected shape, starting empty`);
      return;
    }
    for (const [id, snap] of Object.entries(file.snapshots)) {
      if (
        snap &&
        typeof snap === 'object' &&
        typeof snap.providerId === 'string' &&
        typeof snap.keyHashPrefix === 'string' &&
        Array.isArray(snap.windows) &&
        typeof snap.verifiedAt === 'number'
      ) {
        this.snapshots.set(id, snap);
      }
    }
    if (file.failures && typeof file.failures === 'object') {
      for (const [id, f] of Object.entries(file.failures)) {
        if (f && typeof f === 'object' && typeof f.reason === 'string' && typeof f.at === 'number') {
          this.failures.set(id, f);
        }
      }
    }
  }

  public get(providerId: string, keyHashPrefix: string): QuotaSnapshot | undefined {
    this.ensureLoaded();
    return this.snapshots.get(quotaPairId(providerId, keyHashPrefix));
  }

  /** All snapshots (console coverage view, tests). */
  public list(): QuotaSnapshot[] {
    this.ensureLoaded();
    return [...this.snapshots.values()];
  }

  /** Replace the snapshot for a pair and schedule the durable write. */
  public put(snapshot: QuotaSnapshot): void {
    this.ensureLoaded();
    this.snapshots.set(quotaPairId(snapshot.providerId, snapshot.keyHashPrefix), snapshot);
    this.scheduleSave();
  }

  /**
   * Write path of the PASSIVE L-a channel (inference-header harvest).
   * Measured snapshots fill absence or refresh their own kind only —
   * endpoint-verified knowledge (probed / forked / declared) outranks passive
   * header inference and is never overwritten here. Returns whether a write
   * happened (test/inspection seam).
   */
  public putMeasured(snapshot: QuotaSnapshot): boolean {
    this.ensureLoaded();
    const id = quotaPairId(snapshot.providerId, snapshot.keyHashPrefix);
    const existing = this.snapshots.get(id);
    if (existing && existing.source !== 'measured') return false;
    this.snapshots.set(id, snapshot);
    this.scheduleSave();
    return true;
  }

  /**
   * Record a failed attempt: probe failure is not a quota failure — old values
   * are KEPT, only `lastFailureAt` moves (which flips the badge to `stale`).
   * The verdict itself goes into the failure table, so a pair that NEVER
   * succeeded still shows WHY it is empty instead of an eternal `unverified`.
   */
  public markFailure(providerId: string, keyHashPrefix: string, detail?: Omit<QuotaProbeFailure, 'at'>): void {
    const id = quotaPairId(providerId, keyHashPrefix);
    const at = this.nowFn();
    this.ensureLoaded();
    this.failures.set(id, { reason: 'status', ...(detail ?? {}), at });
    const existing = this.snapshots.get(id);
    if (existing) {
      // Keeps the old windows; the badge reads `lastFailureAt >= verifiedAt`.
      this.snapshots.set(id, { ...existing, lastFailureAt: at });
    }
    this.scheduleSave();
  }

  /** Why the most recent attempt produced nothing (absent = never failed, or
   *  the last attempt succeeded — success clears the record). */
  public getFailure(providerId: string, keyHashPrefix: string): QuotaProbeFailure | undefined {
    this.ensureLoaded();
    return this.failures.get(quotaPairId(providerId, keyHashPrefix));
  }

  /** A success invalidates the failure verdict (a stale reason must never
   *  outlive the evidence it described). */
  public clearFailure(providerId: string, keyHashPrefix: string): void {
    this.ensureLoaded();
    if (this.failures.delete(quotaPairId(providerId, keyHashPrefix))) this.scheduleSave();
  }

  public clear(providerId: string, keyHashPrefix: string): void {
    this.ensureLoaded();
    this.snapshots.delete(quotaPairId(providerId, keyHashPrefix));
    this.failures.delete(quotaPairId(providerId, keyHashPrefix));
    this.scheduleSave();
  }

  /**
   * The badge state for a covered pair:
   *  - no snapshot + no attempt    -> unverified
     *  - declared-source snapshot     -> declared
   *  - snapshot inside its cache window (fresh probe after last failure) -> probed
   *  - snapshot past cacheTtl OR last attempt failed -> stale
   * `ttlMs` comes from the live entry (config may retune built-ins).
   */
  public badgeState(
    providerId: string,
    keyHashPrefix: string,
    ttlMs: number,
    now: number = this.nowFn()
  ): QuotaBadgeState {
    const snap = this.get(providerId, keyHashPrefix);
    if (!snap) return 'unverified';
    if (snap.source === 'declared') return 'declared';
    if (snap.lastFailureAt !== undefined && snap.lastFailureAt >= snap.verifiedAt) return 'stale';
    if (now - snap.verifiedAt > ttlMs) return 'stale';
    return 'probed';
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 300);
    this.saveTimer.unref?.();
  }

  /** Force the pending write (boot shutdown + tests). */
  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.saveNow();
  }

  private saveNow(): void {
    const file = this.filePath;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (this.preserveCorrupt) {
        this.preserveCorrupt = false;
        try {
          fs.copyFileSync(file, `${file}.corrupt.${Date.now()}`);
        } catch {
          // best effort
        }
      }
      const payload: QuotaFile = {
        version: 1,
        snapshots: Object.fromEntries(this.snapshots),
        ...(this.failures.size > 0 ? { failures: Object.fromEntries(this.failures) } : {}),
      };
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      renameWithRetry(tmp, file);
    } catch (err: any) {
      console.warn(`[quota] snapshot save failed: ${err?.message ?? err}`);
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────
// Boot attaches exactly one store (index.ts); call sites reach it through the
// accessor. Tests swap the instance via the seam, like the rate-limit ledger.

let instance: QuotaSnapshotStore | undefined;

export function getQuotaStore(): QuotaSnapshotStore {
  if (!instance) instance = new QuotaSnapshotStore();
  return instance;
}

/** Test seam — swap in a fresh (or inspected) store. */
export function setQuotaStoreForTests(next?: QuotaSnapshotStore): QuotaSnapshotStore | undefined {
  const previous = instance;
  instance = next;
  return previous;
}
