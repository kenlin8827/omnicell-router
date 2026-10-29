import fs from 'node:fs';
import path from 'node:path';
import { peekEnvName } from '../config/env.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import {
  CredentialPaths,
  breakerStateFile,
  resolveDefaultPaths,
} from '../opencode/credentials/paths.js';
import {
  BreakerRecord,
  BreakerReasonCode,
  BreakerStateFile,
  CircuitBreakerState,
  ERROR_CATEGORIES,
  BREAKER_REASON_CODES,
} from './types.js';

/**
 * Breaker memory on disk.
 *
 * Before this the whole circuit-breaker state machine lived only in process
 * memory: a restart cleared every cooldown, so a gateway could re-hammer an
 * credential still inside its 12h quota cooldown minutes after booting. This
 * store persists the FULL state of every model and pair breaker
 * (`<OCR_HOME>/breaker-state.<env>.json`, per environment so an env switch
 * cannot rewrite the other book-set's memory) and replays it at boot.
 *
 * File doctrines are the CredentialStateStore ones, deliberately: atomic
 * temp+rename 0600 write, load-once where a missing/malformed file is an
 * empty memory (never fatal), and a corrupt-but-present file is renamed
 * aside on the first write instead of being overwritten (cp-dataloss — the
 * file may be the only record of why an credential was parked).
 *
 * Writes are DEBOUNCED: mutations are rare but a failure storm can produce
 * many in a second, and the loss window of a crash is bounded by the debounce
 * (same doctrine as the governance overlay: a brief loss is under-shaping, the
 * next failure re-trips). The production value is config-driven
 * (`circuitBreaker.persistence.debounceMs`, resolved default 1000ms — the boot
 * path passes it to `defaultBreakerStateStore`); the constant below is only the
 * fallback for stores constructed without config (tests, harnesses). A
 * `process.on('exit')` hook calls `flush()` on every cooperative exit path —
 * including `process.exit` (the console's restart route), which never runs
 * signal handlers. Hard kills (taskkill /F, power loss) have no handler at
 * all: there the debounce window is the honest loss bound.
 */

/** Fallback flush debounce for stores built without config (the boot path always passes `persistence.debounceMs`). */
export const DEFAULT_BREAKER_PERSIST_DEBOUNCE_MS = 1000;

export interface BreakerStateStoreDeps {
  /** Injection seam for tests — same CredentialPaths the other stores use. */
  paths?: CredentialPaths;
  debounceMs?: number;
}

const STATES: CircuitBreakerState[] = ['CLOSED', 'OPEN', 'HALF_OPEN'];

/**
 * Trust-boundary validation (cp-boundary): a hand-edited or half-written file
 * must never push NaN/timewarp values into a live state machine. Invalid
 * records are dropped; invalid scalars inside an otherwise sane record fall
 * back to their zero value.
 */
function sanitizeRecord(raw: unknown): BreakerRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.modelId !== 'string' || !r.modelId) return null;
  if (typeof r.provider !== 'string' || !r.provider) return null;
  if (!STATES.includes(r.state as CircuitBreakerState)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const rec: BreakerRecord = {
    modelId: r.modelId,
    provider: r.provider,
    state: r.state as CircuitBreakerState,
    consecutiveFailures: num(r.consecutiveFailures),
    totalRequests: num(r.totalRequests),
    totalSuccesses: num(r.totalSuccesses),
    totalFailures: num(r.totalFailures),
    lastFailureTime: num(r.lastFailureTime),
    lastSuccessTime: num(r.lastSuccessTime),
    trippedAt: num(r.trippedAt),
    cooldownUntil: num(r.cooldownUntil),
    currentCooldownMs: num(r.currentCooldownMs),
    halfOpenProbes: num(r.halfOpenProbes),
    halfOpenSuccesses: num(r.halfOpenSuccesses),
    halfOpenEnteredAt: num(r.halfOpenEnteredAt),
    outcomeWindow: Array.isArray(r.outcomeWindow) ? r.outcomeWindow.filter(v => v === true || v === false) : [],
  };
  // `''` (the chain-less SENTINEL prefix) is a real key — the string-typed
  // check is the guard, never truthiness, or a chain-less provider's whole
  // breaker memory vanishes on every restart.
  if (typeof r.keyHashPrefix === 'string') rec.keyHashPrefix = r.keyHashPrefix;
  if (r.tier === 'lite' || r.tier === 'plus' || r.tier === 'pro' || r.tier === 'ultra') rec.tier = r.tier;
  if (typeof r.reason === 'string') rec.reason = r.reason;
  // Reason vocabulary is closed at the boundary: a hand-edited file cannot
  // inject arbitrary strings into the live record (the console renders
  // unknown codes via formatReason's fallback anyway — dropping is lossless).
  if (typeof r.reasonCode === 'string' && (BREAKER_REASON_CODES as readonly string[]).includes(r.reasonCode)) {
    rec.reasonCode = r.reasonCode as BreakerReasonCode;
  }
  if (r.reasonParams && typeof r.reasonParams === 'object') {
    // The contract is a flat map of primitives; nested/oversized objects from
    // a hand-edited file would render as [object Object] and ride along on
    // every subsequent save — filter to primitives, drop the rest.
    const clean: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(r.reasonParams as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
    }
    if (Object.keys(clean).length) rec.reasonParams = clean as BreakerRecord['reasonParams'];
  }
  // Scope label: closed three-value vocabulary — anything else is a hand-edit
  // artifact and drops losslessly.
  if (r.scope === 'pair' || r.scope === 'credential' || r.scope === 'model') rec.scope = r.scope;
  if (typeof r.category === 'string' && (ERROR_CATEGORIES as readonly string[]).includes(r.category)) {
    rec.category = r.category as BreakerRecord['category'];
  }
  return rec;
}

export class BreakerStateStore {
  /** Undefined = resolve from the real environment at first touch (boot path). */
  private readonly paths: CredentialPaths | undefined;
  private readonly debounceMs: number;
  private loaded = false;
  private file: BreakerStateFile | null = null;
  private resolvedFile: string | undefined;
  // A file that existed but could not be parsed is preserved on the first
  // write instead of being overwritten (same cp-dataloss rule as the
  // suspect-flag file).
  private preserveCorrupt = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingBuild: (() => BreakerStateFile) | undefined;

  constructor(deps: BreakerStateStoreDeps = {}) {
    this.paths = deps.paths;
    this.debounceMs = deps.debounceMs ?? DEFAULT_BREAKER_PERSIST_DEBOUNCE_MS;
  }

  /** Where the memory lives — log/diagnostic surface, never a secret. */
  public get filePath(): string {
    if (!this.resolvedFile) {
      this.resolvedFile = breakerStateFile(this.paths ?? resolveDefaultPaths(), peekEnvName());
    }
    return this.resolvedFile;
  }

  /** Load-once; a missing or malformed file is empty memory (never fatal). */
  public load(): BreakerStateFile | null {
    if (this.loaded) return this.file;
    this.loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null; // genuinely absent -> fresh memory
      // Present but unreadable (EACCES, a transient AV/indexer lock): treat
      // it as empty memory LOUDLY, and mark it for preservation — silently
      // returning null here would let the first successful save overwrite
      // the whole cooldown ledger without a trace.
      this.preserveCorrupt = true;
      console.warn(`[resilience] breaker memory unreadable (${this.filePath}, ${code}); starting with empty memory, file preserved aside on first write`);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Loud, not silent: a half-written file must not read as "no cooldowns".
      this.preserveCorrupt = true;
      console.warn(
        `[resilience] ${this.filePath} is unparseable, starting with empty breaker memory: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return null;
    }
    const file = parsed as Partial<BreakerStateFile>;
    if (file.version !== 1 || !Array.isArray(file.models) || !Array.isArray(file.pairs)) {
      this.preserveCorrupt = true;
      console.warn(`[resilience] ${this.filePath} has an unexpected shape, starting with empty breaker memory`);
      return null;
    }
    const models = file.models.map(sanitizeRecord).filter((r): r is BreakerRecord => r !== null);
    const pairs = file.pairs
      .map(sanitizeRecord)
      .filter((r): r is BreakerRecord => r !== null && r.keyHashPrefix !== undefined);
    this.file = {
      version: 1,
      savedAt: typeof file.savedAt === 'number' && Number.isFinite(file.savedAt) ? file.savedAt : 0,
      models,
      pairs,
    };
    return this.file;
  }

  /**
   * Coalesce saves: the FIRST mutation arms a debounce timer, later ones just
   * replace the snapshot thunk. The thunk is evaluated at flush time, so the
   * written file always reflects the state machine's latest truth.
   */
  public requestSave(build: () => BreakerStateFile): void {
    this.pendingBuild = build;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    // Never hold the event loop open for a background snapshot (test runners,
    // CLI one-shots).
    this.timer.unref?.();
  }

  /** Write any pending snapshot NOW (shutdown hook; debounce fires this too). */
  public flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const build = this.pendingBuild;
    if (!build) return;
    this.pendingBuild = undefined;
    let tmpPath: string | undefined;
    try {
      if (this.preserveCorrupt) {
        try {
          fs.renameSync(this.filePath, `${this.filePath}.corrupt.${Date.now()}`);
          this.preserveCorrupt = false; // only after the aside really landed —
        } catch {
          // clearing it before a failed rename would let the atomic write
          // below clobber the very file cp-dataloss exists to protect.
          // best effort — a rename race must not block the write of live state
        }
      }
      const content = `${JSON.stringify(build(), null, 2)}\n`;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // Atomic write (temp + rename), best-effort 0600 — OcrStore.save precedent.
      // NOTE: the mode bits are effectively a no-op on Windows (they map to
      // the read-only attribute only); real ACLs would need icacls. Accepted
      // because the payload is display-safe.
      tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        // best effort — Windows chmod semantics differ
      }
      renameWithRetry(tmpPath, this.filePath);
    } catch (e) {
      // The gateway keeps running on in-memory breakers; only persistence
      // degrades. Loud so an operator on a read-only HOME notices the gap.
      console.warn(`[resilience] breaker memory save failed (${this.filePath}): ${e instanceof Error ? e.message : String(e)}`);
      // Re-arm the snapshot: the failure may be transient (AV holding the
      // rename target for a second, a momentary ENOSPC). Dropping it here
      // would mean the NEXT shutdown flush is a no-op and a manual trip is
      // permanently lost even though the disk recovered. The next mutation
      // or the exit flush retries; a permanently broken HOME degrades to a
      // warn per attempt, bounded the same as any other warn.
      this.pendingBuild = this.pendingBuild ?? build;
      if (tmpPath) {
        try {
          fs.unlinkSync(tmpPath); // no orphaned tmp files beside credentials.json
        } catch {
          // best effort
        }
      }
    }
  }

  /** Test seam: drop any pending snapshot/timer without writing. */
  public cancelPendingForTests(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pendingBuild = undefined;
  }
}

// ---------------------------------------------------------------------------
// Process-wide default (the boot path uses it; tests inject their own store).
// ---------------------------------------------------------------------------

let defaultStore: BreakerStateStore | null = null;

/**
 * The process-wide store the boot path attaches (paths resolved from the real
 * environment at first touch; the production debounce comes from
 * `circuitBreaker.persistence.debounceMs`, passed here by the boot path).
 * Anything with an injected `CredentialPaths` — every test — constructs its
 * own `BreakerStateStore` instead.
 */
export function defaultBreakerStateStore(deps: BreakerStateStoreDeps = {}): BreakerStateStore {
  if (!defaultStore) defaultStore = new BreakerStateStore(deps);
  return defaultStore;
}

/** Test seam: drop the memoized default so the next access re-reads env. */
export function resetBreakerStateStoreForTests(): void {
  if (defaultStore) defaultStore.cancelPendingForTests();
  defaultStore = null;
}
