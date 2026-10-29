import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  resolveBreakerRules,
} from './circuit-breaker.js';
import { BreakerStateStore } from './breaker-state.js';
import { CredentialStateStore, defaultCredentialStateStore } from './credential-state.js';
import {
  AutomaticTrippingStatus,
  BreakerReasonCode,
  BreakerRecord,
  BreakerRulesStatus,
  BreakerScopeOverride,
  BreakerStateFile,
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
  ErrorDiagnosis,
  ResolvedBreakerRules,
  RetryConfig,
  TripScope,
} from './types.js';
import { ModelRegistration } from '../config/types.js';
import { ReasonParams } from '../types/router.js';
import type { TierLevel } from '../types/router.js';
import { recordQuotaEvent } from '../quota/events.js';

export interface CircuitBreakerSummary {
  object: 'circuit_breaker_summary';
  total: number;
  healthy: number;
  tripped: number;
  halfOpen: number;
  breakers: CircuitBreakerSnapshot[];
}

// Manual trip defaults: 1h unless a duration is provided; hard-clamped to 7d
export const MANUAL_TRIP_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
export const MANUAL_TRIP_MAX_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

export interface ManualTripOptions {
  reason?: string;
  cooldownMs?: number;
}

/** Where a scoped manual action points. Unused fields depend on the scope. */
export interface ScopeTarget {
  modelId?: string;
  keyHashPrefix?: string;
  providerId?: string;
  /** The provider's full credential chain — widens a model-scope manual trip
   *  to every chain tuple (operator takedown must take the model OUT, not just
   *  the sentinel tuple). */
  chainPrefixes?: readonly string[];
}

/** Gate verdict of a (model, credential) breaker — same shape as `canExecute`. */
export interface BreakerGate {
  allowed: boolean;
  reason?: string;
  state: CircuitBreakerState;
}

export interface TripResult {
  tripped: boolean;
  /** Breakers taken down — 0 means the target did not exist (caller returns 400). */
  affected: number;
  message: string;
}

/** Aggregate availability of one model, with the credentials that are out of it. */
export interface ModelAvailability {
  available: boolean;
  /** Candidate prefixes that cannot serve: tuple OPEN/unavailable, or credential SUSPECT. */
  openPrefixes: string[];
}

/**
 * Model-level CAPABILITY view used by session-pin eviction — derived purely
 * from the (model × credential) tuple breakers; there is NO model-level state
 * machine behind it. `CLOSED / HALF_OPEN / OPEN` are `CircuitBreaker` states
 * (component layer); a model aggregates many tuples, so its view reads in
 * capability terms (the plain health dual `available`/`unavailable`, refined
 * by the middle state `recovering` the boolean cannot express):
 *   'available'   — some credential can serve right now;
 *   'recovering'  — nothing can serve yet, but a tuple is mid-trial: one
 *                   successful probe closes it;
 *   'unavailable' — nothing can serve and no trial is in flight: every tuple
 *                   hard-OPEN / DISABLED / SUSPECT (cooldown expiry or an
 *                   operator action is the only way back).
 * Built from breaker STATES (non-consuming, `viewState()` below), never the
 * peek verdict: a busy canary makes the peek read unavailable, and evicting
 * on that would burn the session's KV cache one probe before recovery — and
 * recovery never pulls traffic switch-back. Shadow mode folds the same way
 * the `verdict()` contract does: an automatic trip under shadow still SERVES,
 * so it never reads out; MANUAL trips are operator intent and stay verbatim.
 */
export type ModelHealthView = 'available' | 'recovering' | 'unavailable';

/**
 * The atomic breaker unit: one (model × credential) tuple.
 * `keyHashPrefix === ''` is the SENTINEL for the chain-less credential (the
 * config-baked key of a provider with no credential chain) — every legacy
 * model-level path degenerates to that one tuple, byte-for-byte.
 */
interface PairRecord {
  modelId: string;
  keyHashPrefix: string;
  provider: string;
  breaker: CircuitBreaker;
  /** Blast-radius label of the last scoped trip/failure delivered here ('model' | 'credential' | 'pair'). */
  lastScope?: TripScope;
}

/**
 * The rule-gate's per-diagnosis decision (resolved ONCE by the manager gate,
 * applied to every target breaker): drop the class, hard-trip with a final
 * duration, count an adjusted copy, or pass the diagnosis through untouched.
 */
type BreakerFailureDispatch =
  | { kind: 'drop' }
  | { kind: 'hard'; cooldownMs: number }
  | { kind: 'count'; diagnosis: ErrorDiagnosis }
  | { kind: 'as-is' };

function pairKey(modelId: string, keyHashPrefix: string): string {
  return `${modelId}::${keyHashPrefix}`;
}

/** Worst-state fold order for derived model views. */
const STATE_SEVERITY: Record<CircuitBreakerState, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

/**
 * Circuit breaker registry over (model × credential) tuple breakers — the
 * ONLY state machines. Every wider granularity is a fan-out WRITE over tuples
 * plus a scope label the tuple keeps for display:
 *
 *   scope 'pair'      -> this one tuple (provider + modelId + credential)
 *   scope 'credential' -> every tuple of (provider, credential) — the key, on
 *                         every model it can reach
 *   scope 'model'      -> every tuple of the modelId (the upstream/model is
 *                         what failed — key-independent)
 *
 * A provider whose chain has a single (or no) credential routes through the
 * sentinel tuple `keyHashPrefix === ''`: every legacy model-level path
 * (no-prefix gate/success/failure) lands there, so chain-less providers keep
 * exactly one breaker with the historical semantics.
 *
 * With a `BreakerStateStore` attached (boot path only) the registry also has
 * an on-disk memory: cooldowns, backoff position and manual trips survive a
 * gateway restart. Without one it stays purely in-memory.
 */
export class CircuitBreakerManager {
  private tuples = new Map<string, PairRecord>();
  // modelId -> provider, so credential-wide expansion and SUSPECT lookups can name the
  // credential owner even for tuples created lazily on a failure path.
  private modelProviders = new Map<string, string>();
  private modelTiers = new Map<string, TierLevel | undefined>();
  private config: CircuitBreakerConfig;
  /**
   * The effective ruleset, resolved at construction and re-resolved on every
   * `applyConfig` (spec invariant 5/6: startup resolution + hot-apply; every
   * breaker receives the swap via its own `applyConfig`). The manager gate
   * consults it for EVERY failure decision, so the rule toggles hold for both
   * the orchestrator and the ActiveHealthProber — the prober classifies WITHOUT
   * circuit config, which is exactly why the gating lives here and never in
   * the classifier (invariant 1).
   */
  private rules: ResolvedBreakerRules;
  private nowFn: () => number;
  private credentialState: CredentialStateStore;
  // optional on-disk breaker memory.
  // Undefined = pure in-memory (every test harness and any registry the boot
  // path never attaches a store to).
  private stateStore: BreakerStateStore | undefined;

  constructor(
    config?: CircuitBreakerConfig,
    nowFn: () => number = Date.now,
    credentialState?: CredentialStateStore,
    // Only consulted for trip.rateLimit.hardTripAboveMs's default
    // (retry.inplace.maxRateLimitWaitMs); the breaker side never rewrites the
    // retry-side in-place-retry decision.
    retryConfig?: RetryConfig
  ) {
    this.config = config || {};
    this.rules = resolveBreakerRules(this.config, retryConfig);
    this.nowFn = nowFn;
    this.credentialState = credentialState ?? defaultCredentialStateStore();
  }

  /**
   * Hot-apply a new circuitBreaker config (spec invariant 6, hot-apply):
   * re-resolve the effective ruleset, swap it into the gate, and push config
   * + the new rules into every live tuple breaker. Breaker STATE is never
   * touched by the swap — the new rules govern from the next decision point —
   * except the invariant-2 reconciliation below. `retryConfig` is consulted
   * only for `hardTripAboveMs`'s default, exactly like boot. Deliberately NOT
   * hot-applied here: `persistence.debounceMs` (the BreakerStateStore binds
   * its debounce at construction, boot path).
   */
  public applyConfig(config?: CircuitBreakerConfig, retryConfig?: RetryConfig): void {
    this.config = config || {};
    this.rules = resolveBreakerRules(this.config, retryConfig);
    // Invariant-2 reconciliation, the live twin of restoreState()'s startup
    // filter (a restart is no longer the only apply point): an OPEN breaker
    // whose reasonCode belongs to a rule this save disables is reset NOW —
    // otherwise the block nobody asked for would outlive the toggle.
    // breaker.canary / breaker.manual never reconcile (same predicate as
    // restore). Read via toRecord(), NOT getSnapshot(): the read must not
    // transition the machine, so an expired OPEN reconciles exactly like its
    // restored twin instead of slipping into HALF_OPEN first.
    const disabled = CircuitBreakerManager.disabledTripReasonCodes(this.rules);
    const settle = (breaker: CircuitBreaker): void => {
      breaker.applyConfig(this.config, this.rules);
      const rec = breaker.toRecord();
      if (rec.state === 'OPEN' && rec.reasonCode !== undefined && disabled.has(rec.reasonCode)) {
        breaker.reset();
      }
    };
    for (const tuple of this.tuples.values()) settle(tuple.breaker);
  }

  /** Registry bookkeeping only — tuple breakers are created lazily on first evidence. */
  public registerModel(model: ModelRegistration): void {
    this.modelProviders.set(model.id, model.provider);
    this.modelTiers.set(model.id, model.tier);
  }

  /**
   * Models this registry knows for a provider — the model set a credential-wide
   * trip covers (registerModel is called for every registered model).
   */
  private modelsOfProvider(providerId?: string): string[] {
    if (!providerId || providerId === 'unknown') return [];
    const out: string[] = [];
    for (const [id, provider] of this.modelProviders) {
      if (provider === providerId) out.push(id);
    }
    return out;
  }

  /**
   * Models a credential-wide trip of (provider, credential) covers: everything
   * registered for that provider, plus any model that already carries a tuple
   * for the credential (a tuple can outlive a provider re-index).
   */
  private credentialModelIds(providerId: string, keyHashPrefix: string): string[] {
    const out = new Set<string>(this.modelsOfProvider(providerId));
    for (const tuple of this.tuples.values()) {
      if (tuple.keyHashPrefix === keyHashPrefix && tuple.provider === providerId) out.add(tuple.modelId);
    }
    return Array.from(out);
  }

  /** Tuple prefixes currently materialized for a model. */
  private tuplePrefixesOf(modelId: string): string[] {
    const out: string[] = [];
    for (const tuple of this.tuples.values()) {
      if (tuple.modelId === modelId) out.push(tuple.keyHashPrefix);
    }
    return out;
  }

  /**
   * The tuple set a model-scope failure/trip lands on: the caller's chain
   * prefixes when known (the orchestrator passes them, so a model-scope trip
   * covers credentials that never failed yet), else the materialized tuples,
   * else the sentinel '' tuple (chain-less). Every target is created on demand
   * so the fan-out is durable and visible in the matrix.
   */
  private modelTupleTargets(modelId: string, provider?: string, chainPrefixes?: readonly string[]): PairRecord[] {
    const prefixes =
      chainPrefixes && chainPrefixes.length > 0
        ? Array.from(new Set(chainPrefixes))
        : this.tuplePrefixesOf(modelId);
    const effective = prefixes.length > 0 ? prefixes : [''];
    return effective.map((prefix) => this.getOrCreateTuple(modelId, prefix, provider));
  }

  /** The pair breaker for (model, credential), or undefined if none exists. */
  public getPairBreaker(modelId: string, keyHashPrefix: string): CircuitBreaker | undefined {
    return this.tuples.get(pairKey(modelId, keyHashPrefix))?.breaker;
  }

  /**
   * Trial-call budget per model per prober cycle (Decision 6 reuses the
   * HALF_OPEN trial budget, so tuple fan-out cannot multiply background load).
   * = rules.recovery.halfOpen.maxProbes, defaulting to halfOpenMaxProbes.
   */
  public getProbeBudget(): number {
    return this.rules.recovery.halfOpen.maxProbes;
  }

  private getOrCreateTuple(modelId: string, keyHashPrefix: string, provider?: string): PairRecord {
    const key = pairKey(modelId, keyHashPrefix);
    let tuple = this.tuples.get(key);
    if (!tuple) {
      const owner = this.resolveProvider(modelId, provider);
      tuple = {
        modelId,
        keyHashPrefix,
        provider: owner,
        breaker: new CircuitBreaker(
          modelId,
          owner,
          this.modelTiers.get(modelId),
          this.config,
          this.nowFn,
          this.rules
        ),
      };
      this.tuples.set(key, tuple);
    }
    return tuple;
  }

  /**
   * CONSUMING gate for the no-chain path: the sentinel '' tuple (the config
   * -baked key of a chain-less provider). Multi-credential traffic never goes
   * through here — `canExecuteScoped` with a real prefix is the gate.
   */
  public canExecute(modelId: string): { allowed: boolean; reason?: string; state: CircuitBreakerState } {
    const tuple = this.tuples.get(pairKey(modelId, ''));
    if (!tuple) {
      return { allowed: true, state: 'CLOSED' };
    }
    const check = tuple.breaker.canExecute();
    return {
      allowed: check.allowed,
      reason: check.reason,
      state: tuple.breaker.getState(),
    };
  }

  /**
   * CONSUMING gate at the finest attributed scope — the ONE tuple (provider +
   * modelId + credential). No `keyHashPrefix` (chain-less provider) is exactly
   * `canExecute(modelId)` on the sentinel tuple.
   */
  public canExecuteScoped(modelId: string, keyHashPrefix?: string): BreakerGate {
    if (!keyHashPrefix) {
      return this.canExecute(modelId);
    }

    const tuple = this.tuples.get(pairKey(modelId, keyHashPrefix));
    if (this.isSuspect(modelId, keyHashPrefix)) {
      return {
        allowed: false,
        reason:
          `Credential '${keyHashPrefix}' is SUSPECT for model '${modelId}' ` +
          '(confirmed-bad credential; reconnect or clear to restore).',
        state: tuple ? tuple.breaker.getState() : 'OPEN',
      };
    }
    if (!tuple) {
      // No tuple state = never failed on this credential.
      return { allowed: true, state: 'CLOSED' };
    }
    const check = tuple.breaker.canExecute();
    return { allowed: check.allowed, reason: check.reason, state: tuple.breaker.getState() };
  }

  /**
   * NON-CONSUMING availability check (peek) — safe for selection, filtering
   * and introspection; never takes a HALF_OPEN probe slot. A model is
   * available while ANY of its tuple breakers is peek-allowed (no tuples =
   * never failed anywhere = available). The consuming gate is
   * `canExecuteScoped()` at the execution site only.
   */
  public isAvailable(modelId: string): boolean {
    let sawAny = false;
    for (const tuple of this.tuples.values()) {
      if (tuple.modelId !== modelId) continue;
      sawAny = true;
      if (tuple.breaker.peekExecute().allowed) return true;
    }
    return !sawAny;
  }

  /**
   * The derived aggregate the pool builders read:
   * a model is available iff at least one candidate credential serves (its
   * tuple breaker not OPEN, its credential not SUSPECT/DISABLED). With an
   * EMPTY `candidatePrefixes` (chain-less provider) the SENTINEL tuple is the
   * only gate — consulted via `isAvailable`, so a manual model trip on the
   * sentinel reads out as unavailable exactly like any chained takedown.
   */
  public modelAvailability(modelId: string, candidatePrefixes: string[]): ModelAvailability {
    if (candidatePrefixes.length === 0) {
      // Chain-less: the SENTINEL '' tuple is the only gate (a manual model trip
      // lands there, so it must read out as unavailable, not short-circuit).
      return { available: this.isAvailable(modelId), openPrefixes: [] };
    }

    const openPrefixes: string[] = [];
    for (const prefix of candidatePrefixes) {
      if (this.isPairOut(modelId, prefix)) {
        openPrefixes.push(prefix);
      }
    }
    return { available: openPrefixes.length < candidatePrefixes.length, openPrefixes };
  }

  /**
   * The breaker state as the ROUTING view sees it — the shadow fold of the
   * `verdict()` contract: under `circuitBreaker.shadow` an AUTOMATIC trip
   * runs its full accounting but never denies service, so counting it as
   * down here would evict session pins the routing path happily serves.
   * MANUAL trips are operator intent, never shadowed, and keep their state
   * verbatim (DISABLED / SUSPECT gating lives in the caller, likewise exempt).
   * `getSnapshot()` is non-consuming, exactly like `getState()`.
   */
  private viewState(breaker: CircuitBreaker): CircuitBreakerState {
    const snap = breaker.getSnapshot();
    return this.rules.shadow && snap.category !== 'MANUAL' ? 'CLOSED' : snap.state;
  }

  /**
   * Model capability view for session-pin eviction (see `ModelHealthView`),
   * folded purely from tuple states — there is no model-level machine. A
   * tuple OPEN does not immediately condemn the model (another credential may
   * serve); 'unavailable' requires EVERY candidate to be out (operator
   * takedowns outrank trial state and serve as 'out', never 'recovering').
   * Chain-less providers degenerate to the sentinel '' tuple alone.
   */
  public modelHealthView(modelId: string, candidatePrefixes: string[]): ModelHealthView {
    const prefixes = candidatePrefixes.length > 0 ? candidatePrefixes : [''];
    let anyHalfOpen = false;
    for (const prefix of prefixes) {
      if (prefix && (this.isDisabled(modelId, prefix) || this.isSuspect(modelId, prefix))) continue; // takedown: serves as 'out', never 'recovering'
      const tuple = this.tuples.get(pairKey(modelId, prefix));
      const state = tuple ? this.viewState(tuple.breaker) : 'CLOSED'; // never failed on this credential
      if (state === 'CLOSED') return 'available';
      if (state === 'HALF_OPEN') anyHalfOpen = true;
    }
    return anyHalfOpen ? 'recovering' : 'unavailable';
  }

  /** Administrative SUSPECT flag for the credential this model belongs to. */
  public isSuspect(modelId: string, keyHashPrefix: string): boolean {
    const providerId = this.resolveProvider(modelId);
    if (providerId === 'unknown') return false;
    return this.credentialState.isSuspect(providerId, keyHashPrefix);
  }

  /**
   * Operator takedown for the credential this model belongs to. Unlike SUSPECT it is
   * never set or lifted by runtime evidence — only the console (or the REST twin)
   * flips it, and it survives reconnect, Push and every cooldown.
   */
  public isDisabled(modelId: string, keyHashPrefix: string): boolean {
    const providerId = this.resolveProvider(modelId);
    if (providerId === 'unknown') return false;
    return this.credentialState.isDisabled(providerId, keyHashPrefix);
  }

  /**
   * The single NON-CONSUMING "out of service" predicate
   * for one (model, credential) tuple: credential SUSPECT/DISABLED, or its
   * breaker currently not peek-allowed. NEVER takes a HALF_OPEN probe slot —
   * the consuming gate is `canExecuteScoped()` at the execution site only.
   * Selection (credential-selection.ts), the prober plan (health-prober.ts)
   * and `modelAvailability()` above all route through this one implementation.
   */
  public isPairOut(modelId: string, keyHashPrefix: string): boolean {
    // Operator takedown outranks every runtime signal: it is the one state that
    // NEVER auto-returns, so it is checked first and shared by all three
    // consumers (selection, prober plan, model availability) through this gate.
    if (this.isDisabled(modelId, keyHashPrefix)) return true;
    if (this.isSuspect(modelId, keyHashPrefix)) return true;
    const tuple = this.tuples.get(pairKey(modelId, keyHashPrefix));
    return tuple !== undefined && !tuple.breaker.peekExecute().allowed;
  }

  /** Retire a model: every tuple breaker and identity bookkeeping goes with it
   *  (the registry's hot pool sync — a removed model must not ghost through
   *  credential-wide expansion or snapshots). */
  public dropModel(modelId: string): void {
    this.schedulePersist();
    for (const [key, tuple] of Array.from(this.tuples)) {
      if (tuple.modelId === modelId) this.tuples.delete(key);
    }
    this.modelProviders.delete(modelId);
    this.modelTiers.delete(modelId);
  }

  public getCredentialStateStore(): CredentialStateStore {
    return this.credentialState;
  }

  // -- Breaker memory persistence ---------

  /**
   * Attach the on-disk breaker memory. NOT done by the constructor: the boot
   * path attaches only after every config model is registered, and test /
   * harness registries never attach at all — their breakers stay exactly as
   * in-memory as they always were.
   */
  public attachStateStore(store: BreakerStateStore): void {
    this.stateStore = store;
  }

  /**
   * Rehydrate tuple breakers from disk. Records for models the registry no
   * longer knows (config removed/renamed them over the restart) are DROPPED,
   * so the file self-cleans and removed models never ghost through snapshots
   * or credential-wide trip expansion. OPEN records whose reasonCode belongs
   * to a now-disabled trip rule are skipped too — the startup reconciliation
   * of spec invariant 2: closing a rule must not resurrect a cooldown nobody
   * asked for (the same filter runs live in `applyConfig` at every hot-apply,
   * invariant 6). Pre-tuple files carried a `models[]` layer; those records
   * are IGNORED (the model level is a derived view now). Returns the applied
   * tuple count.
   */
  public restoreState(): { pairs: number } {
    const file = this.stateStore?.load();
    if (!file) return { pairs: 0 };
    const disabled = CircuitBreakerManager.disabledTripReasonCodes(this.rules);
    const revived = (rec: BreakerRecord): boolean =>
      rec.state === 'OPEN' && rec.reasonCode !== undefined && disabled.has(rec.reasonCode);
    let pairs = 0;
    for (const rec of file.pairs) {
      // `''` (the chain-less SENTINEL tuple) is a real key — only undefined is
      // absent; dropping it would erase a chain-less provider's ENTIRE breaker
      // memory on every restart.
      if (rec.keyHashPrefix === undefined || !this.modelProviders.has(rec.modelId) || revived(rec)) continue;
      // getOrCreateTuple resolves the owner from the registry (resolveProvider).
      const tuple = this.getOrCreateTuple(rec.modelId, rec.keyHashPrefix);
      tuple.breaker.applyRecord(rec);
      tuple.lastScope = rec.scope;
      pairs++;
    }
    return { pairs };
  }

  /** Trip reasonCodes whose owning rule is disabled — those records/breakers reconcile away (invariant 2). */
  private static disabledTripReasonCodes(rules: ResolvedBreakerRules): Set<BreakerReasonCode> {
    const out = new Set<BreakerReasonCode>();
    const t = rules.trip;
    if (!t.quota.enabled) out.add('breaker.quota');
    if (!t.auth.enabled) out.add('breaker.auth');
    // rateLimit OFF downgrades new 429s to counted failures; an existing hard
    // 429 block belongs to the disabled rule just the same.
    if (!t.rateLimit.enabled) out.add('breaker.rate_limit');
    if (!t.consecutiveFailures.enabled) out.add('breaker.consecutive');
    if (!t.failureRate.enabled) out.add('breaker.rate_window');
    // breaker.canary wraps whatever cause tripped it (never a rule's direct
    // record), breaker.manual is operator intent — neither reconciles.
    return out;
  }

  /** The live full-state file (called by the debounced store, never hot-path).
   *  `models` stays an always-empty field for file-shape compatibility — the
   *  model level is a derived view with no state of its own (v2 semantics). */
  private buildStateFile(): BreakerStateFile {
    return {
      version: 1,
      savedAt: this.nowFn(),
      models: [],
      pairs: Array.from(this.tuples.values(), p => ({
        ...p.breaker.toRecord(),
        keyHashPrefix: p.keyHashPrefix,
        // The scope label rides the pair record so scope-symmetric recovery
        // survives restarts (the frontend keys its recover action off it).
        ...(p.lastScope ? { scope: p.lastScope } : {}),
      })),
    };
  }

  /**
   * Arm a debounced snapshot at every public mutation entry point. Lazy
   * internal transitions (OPEN->HALF_OPEN on a gate check, canary-slot
   * accounting) need no hook of their own: a request that consumes a probe
   * slot always ends in recordSuccess/recordFailure, which schedules here.
   */
  private schedulePersist(): void {
    if (!this.stateStore) return;
    this.stateStore.requestSave(() => this.buildStateFile());
  }

  /** Success on the sentinel '' tuple — the chain-less legacy path. */
  public recordSuccess(modelId: string): void {
    this.schedulePersist();
    this.getOrCreateTuple(modelId, '').breaker.recordSuccess();
  }

  /** Provider owner of a model as this registry knows it ('unknown' when never seen). */
  private resolveProvider(modelId: string, provider?: string): string {
    if (provider && provider !== 'unknown') return provider;
    return this.modelProviders.get(modelId) ?? 'unknown';
  }

  /**
   * Success for one (model, credential) tuple. Without a prefix this is the
   * sentinel-tuple `recordSuccess(modelId)` (chain-less path).
   */
  public recordSuccessScoped(modelId: string, keyHashPrefix?: string, provider?: string): void {
    this.schedulePersist();
    if (!keyHashPrefix) {
      this.recordSuccess(modelId);
      return;
    }
    const owner = this.resolveProvider(modelId, provider);
    const tuple = this.tuples.get(pairKey(modelId, keyHashPrefix));
    if (tuple) {
      tuple.breaker.recordSuccess();
    } else if (owner !== 'unknown') {
      // A success on a never-failed tuple still has to name the owner, or the
      // credential-wide expansion would not know which provider this model belongs to.
      this.getOrCreateTuple(modelId, keyHashPrefix, owner);
    }
  }

  public recordFailure(modelId: string, diagnosis: ErrorDiagnosis, provider = 'unknown'): void {
    this.recordFailureScoped(modelId, diagnosis, provider, undefined);
  }

  /**
   * Record a failure and EXPAND it over the blast radius
   * the rule gate resolved. The credential actually used comes from the
   * caller's prefix OR the registry-stamped `diagnosis.usedKeyHashPrefix` —
   * a degenerate selection (all-unhealthy / no-session) still executed on a
   * chain credential, and its stamp is ground truth. Without either, the
   * failure is chain-less and lands on the sentinel '' tuple.
   *
   *   'pair'      -> this one (model, credential) tuple
   *   'credential' -> every model this credential can reach; SUSPECT if diagnosed
 *   'model'     -> EVERY tuple of the modelId (fan-out accounting: each tuple's
   *                  ladder sees the model-level failure, so one key serving a
   *                  dying upstream trips the whole model at the threshold)
   *
   * A rule `scope` override replaces the classifier's blast radius here —
   * AFTER credential attribution (invariant 4).
   *
   * `chainPrefixes` (optional, orchestrator-only) widens the model-scope
   * fan-out to the full credential chain so a model-level trip covers keys
   * that never served the failing attempt.
   */
  public recordFailureScoped(
    modelId: string,
    diagnosis: ErrorDiagnosis,
    provider?: string,
    keyHashPrefix?: string,
    chainPrefixes?: readonly string[]
  ): void {
    // Quota linkage: every QUOTA_EXHAUSTED diagnosis
    // lands a row in the quota_events ledger at this single join point —
    // BEFORE rule gating, because the event plane is observability and the
    // trip decision is policy (turning quota tripping OFF must not blind the
    // ledger). Failed requests never enter the trace table (that plane
    // records executed turns); this ledger is their quota-shaped counterpart.
    // Fire-and-forget fail-open: a ledger error must never disturb the
    // breaker record it piggybacks on.
    // Attribution ground truth: the caller's selection prefix may be absent
    // (all-unhealthy / all-disabled / no-session degeneracies still execute on
    // the chain head), but `registry.execute` stamped the credential that
    // ACTUALLY served the failed attempt onto the error, and the classifier
    // carried it here as `diagnosis.usedKeyHashPrefix`. That stamp — not the
    // selection outcome — is what scopes the trip: a credential-fault error
    // (quota/auth/per-credential 429) must never degrade to the model level
    // just because selection returned no prefix.
    const attributed = keyHashPrefix ?? diagnosis.usedKeyHashPrefix;
    if (diagnosis.category === 'QUOTA_EXHAUSTED') {
      try {
        recordQuotaEvent({
          providerId: provider ?? this.modelProviders.get(modelId) ?? 'unknown',
          keyHashPrefix: attributed,
          modelId,
          statusCode: diagnosis.statusCode,
          reason: diagnosis.reason,
        });
      } catch {
        // fail open
      }
    }
    this.schedulePersist();
    this.applyFailure(modelId, diagnosis, provider, attributed, chainPrefixes);
  }

  /**
   * The manager-side rule gate (spec invariant 1) — the single join point for
   * the orchestrator AND the ActiveHealthProber (which classifies WITHOUT any
   * circuit config; that gap is closed HERE, never by feeding config to the
   * classifier). Everything rule-shaped is resolved against the diagnosis:
   *
   *   - a counting / trip rule OFF drops the class (a consumed HALF_OPEN probe slot
   *     still releases — non-penalty outcomes must never strand the trial);
   *   - hard-trip durations come from trip.quota/auth.cooldownMs, or from
   *     retryAfterSeconds clamped by trip.rateLimit params — NEVER from
   *     diagnosis.minCooldownMs (that is a statistical-path floor only);
   *   - the 429 hard/counted boundary re-derives from hardTripAboveMs, and
   *     trip.rateLimit OFF downgrades long-Retry-After 429s to counted
   *     statistical failures whose Retry-After-derived floor still flows
   *     through max(min, computed) (rule #3);
   *   - the effective `scope` override picks the blast radius (credential
   *     expansion needs the attribution this call site already has).
   *
   * Never rewrites category/isRetriable (invariant 3): adjustments ride on a
   * copy, the caller's diagnosis object stays untouched.
   */
  private applyFailure(
    modelId: string,
    diagnosis: ErrorDiagnosis,
    provider?: string,
    keyHashPrefix?: string,
    chainPrefixes?: readonly string[]
  ): void {
    const r = this.rules;
    const owner = this.resolveProvider(modelId, provider);
    const dispatch = this.dispatchFailure(diagnosis);
    const deliver = (tuple: PairRecord, scope: TripScope): void => {
      tuple.lastScope = scope;
      switch (dispatch.kind) {
        case 'drop':
          tuple.breaker.releaseProbeSlot();
          return;
        case 'hard':
          tuple.breaker.recordHardTrip(diagnosis, dispatch.cooldownMs);
          return;
        case 'count':
          tuple.breaker.recordFailure(dispatch.diagnosis);
          return;
        default:
          tuple.breaker.recordFailure(diagnosis);
      }
    };

    const scope = this.effectiveScope(diagnosis);
    if (scope === 'model' || !keyHashPrefix) {
      // Model blast radius: every tuple of the model (chain prefixes widen the
      // fan-out; a chain-less provider degenerates to the sentinel tuple).
      for (const tuple of this.modelTupleTargets(modelId, owner, scope === 'model' ? chainPrefixes : undefined)) {
        deliver(tuple, 'model');
      }
      return;
    }
    if (scope === 'pair') {
      deliver(this.getOrCreateTuple(modelId, keyHashPrefix, owner), 'pair');
      return;
    }
    // credential-wide: the credential is the problem, on every model it can serve.
    if (!this.modelProviders.has(modelId)) this.modelProviders.set(modelId, owner);
    const rowTargets = new Set(this.credentialModelIds(owner, keyHashPrefix));
    rowTargets.add(modelId);
    for (const targetId of rowTargets) {
      deliver(this.getOrCreateTuple(targetId, keyHashPrefix, owner), 'credential');
    }
    // SUSPECT is administrative and auth-only: quota recovers by itself, a
    // dead key does not (Decision 6). The flag rides on the trip (spec: mark
    // SUSPECT "on trip"): with the auth rule OFF the 401 is "ignore" (rule
    // semantics #2 — neither trips nor counts), so nothing is flagged. Manual
    // trips never set it, and trip.auth.markSuspect:false stops NEW flags
    // only — existing suspect-credentials.json entries keep gating selection
    // until operator clear (invariant 2: toggles never clear existing flags).
    if (diagnosis.credentialSuspect && r.trip.auth.enabled && r.trip.auth.markSuspect) {
      this.credentialState.mark(owner, keyHashPrefix, diagnosis.reason);
    }
  }

  /** How a diagnosis enters a breaker, fully resolved by the rules (never by the breaker guessing). */
  private dispatchFailure(diagnosis: ErrorDiagnosis): BreakerFailureDispatch {
    const r = this.rules;
    switch (diagnosis.category) {
      case 'QUOTA_EXHAUSTED':
        if (!r.trip.quota.enabled) return { kind: 'drop' };
        return { kind: 'hard', cooldownMs: r.trip.quota.cooldownMs };
      case 'AUTHENTICATION_ERROR':
        if (!r.trip.auth.enabled) return { kind: 'drop' };
        return { kind: 'hard', cooldownMs: r.trip.auth.cooldownMs };
      case 'RATE_LIMITED': {
        // Re-derive the hard/counted boundary from the rule param — the
        // classifier's copy (retry.inplace.maxRateLimitWaitMs by default) only
        // steers the in-place retry decision, never the breaker.
        const raMs = diagnosis.retryAfterSeconds !== undefined ? diagnosis.retryAfterSeconds * 1000 : undefined;
        const hard = raMs !== undefined && raMs > r.trip.rateLimit.hardTripAboveMs;
        if (r.trip.rateLimit.enabled && hard) {
          return { kind: 'hard', cooldownMs: this.rateLimitCooldownMs(raMs) };
        }
        // Counted (short burst, no Retry-After, or the OFF-downgrade of a long
        // RA): the RA-derived floor still flows through max(min, computed).
        const floor = raMs !== undefined ? this.rateLimitCooldownMs(raMs) : r.counting.rateLimitErrors.minCooldownMs;
        return { kind: 'count', diagnosis: { ...diagnosis, hardTrip: false, minCooldownMs: floor } };
      }
      case 'SERVICE_UNAVAILABLE':
        if (!r.counting.serverErrors.enabled) return { kind: 'drop' };
        return {
          kind: 'count',
          diagnosis: { ...diagnosis, hardTrip: false, minCooldownMs: r.counting.serverErrors.minCooldownMs },
        };
      case 'UNKNOWN':
        if (!r.counting.unknownErrors.enabled) return { kind: 'drop' };
        return {
          kind: 'count',
          diagnosis: { ...diagnosis, hardTrip: false, minCooldownMs: r.counting.unknownErrors.minCooldownMs },
        };
      case 'CLIENT_ERROR':
        if (!r.counting.clientErrors.enabled) {
          // Untouched pass-through: today's non-penalty path (releases a probe
          // slot, counts nothing).
          return { kind: 'as-is' };
        }
        // Counted as a failure — the tripping rule's own ladder applies (no
        // cooldown floor param on this row).
        return { kind: 'count', diagnosis: { ...diagnosis, shouldTripBreaker: true, hardTrip: false } };
      default:
        // MANUAL and anything without a rule owner: pass through as recorded.
        return { kind: 'as-is' };
    }
  }

  /** Retry-After 429 cooldown: rule `minCooldownMs` floor, GLOBAL maxCooldownMs ceiling (the clamp cap stays global). */
  private rateLimitCooldownMs(raMs: number): number {
    const ceiling = this.config.maxCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.maxCooldownMs;
    return Math.max(this.rules.trip.rateLimit.minCooldownMs, Math.min(raMs, ceiling));
  }

  /**
   * Blast radius for this diagnosis: the owning rule's `scope` override wins
   * over the classifier's diagnosed scope ('auto' keeps today's). Counted
   * classes feed the two B detectors from one recording path; the first
   * non-auto detector row owns their blast (consecutiveFailures before
   * failureRate — a documented resolution of the spec, which gives both rows
   * a scope cell but one recording decision point).
   */
  private effectiveScope(diagnosis: ErrorDiagnosis): TripScope {
    const t = this.rules.trip;
    let override: BreakerScopeOverride = 'auto';
    switch (diagnosis.category) {
      case 'QUOTA_EXHAUSTED':
        override = t.quota.scope;
        break;
      case 'AUTHENTICATION_ERROR':
        override = t.auth.scope;
        break;
      case 'RATE_LIMITED':
        override = t.rateLimit.scope;
        break;
      case 'SERVICE_UNAVAILABLE':
      case 'UNKNOWN':
      case 'CLIENT_ERROR':
        override = t.consecutiveFailures.scope !== 'auto' ? t.consecutiveFailures.scope : t.failureRate.scope;
        break;
      default:
        break;
    }
    return override !== 'auto' ? override : (diagnosis.tripScope ?? 'model');
  }

  /**
   * Effective-ruleset view for the guardrails banner (spec UX rule 6) — the
   * five-switch predicate: automatic tripping is off iff ALL five trip
   * switches are off (counting-off is NOT a route to zero: counted 429 still
   * feeds the detectors). The full resolved ruleset rides along so the UI can
   * render each `auto` cell's live value.
   */
  public getRulesStatus(): BreakerRulesStatus {
    const t = this.rules.trip;
    const switches = [
      t.quota.enabled,
      t.auth.enabled,
      t.rateLimit.enabled,
      t.consecutiveFailures.enabled,
      t.failureRate.enabled,
    ];
    const on = switches.filter(Boolean).length;
    const automatic: AutomaticTrippingStatus = on === switches.length ? 'on' : on === 0 ? 'all_off' : 'partly_off';
    return { automatic, shadow: this.rules.shadow, rules: this.rules };
  }

  /**
   * Manual reset of one MODEL: every tuple breaker of the model (an operator
   * putting a model back in service does not want a stale credential cooldown
   * to keep the aggregate down). SUSPECT is the separate administrative gate
   * and survives every reset path — only `CredentialStateStore.clear()` lifts
   * it. No argument resets every tuple breaker.
   */
  public reset(modelId?: string): { resetCount: number; message: string } {
    this.schedulePersist();
    if (modelId) {
      let count = 0;
      for (const tuple of this.tuples.values()) {
        if (tuple.modelId !== modelId) continue;
        tuple.breaker.reset();
        count++;
      }
      if (count === 0) {
        return { resetCount: 0, message: `No circuit breaker found for model '${modelId}'.` };
      }
      return { resetCount: count, message: `Circuit breaker for model '${modelId}' reset to CLOSED.` };
    }
    for (const tuple of this.tuples.values()) {
      tuple.breaker.reset();
    }
    const count = this.tuples.size;
    return { resetCount: count, message: `All ${count} circuit breakers successfully reset to CLOSED.` };
  }

  /** Reset one (model, credential) tuple; no prefix degenerates to `reset(modelId)`. */
  public resetScoped(modelId: string, keyHashPrefix?: string): { resetCount: number; message: string } {
    if (!keyHashPrefix) return this.reset(modelId);
    this.schedulePersist();
    const tuple = this.tuples.get(pairKey(modelId, keyHashPrefix));
    if (!tuple) {
      return { resetCount: 0, message: `No pair breaker for model '${modelId}' on credential '${keyHashPrefix}'.` };
    }
    tuple.breaker.reset();
    return {
      resetCount: 1,
      message: `Circuit breaker for model '${modelId}' on credential '${keyHashPrefix}' reset to CLOSED.`,
    };
  }

  public resetByScope(scope: TripScope, target: ScopeTarget): { resetCount: number; message: string } {
    if (scope === 'model') {
      if (!target.modelId) {
        return { resetCount: 0, message: "scope 'model' requires a model." };
      }
      return this.reset(target.modelId);
    }
    if (scope === 'pair') {
      if (!target.modelId || !target.keyHashPrefix) {
        return { resetCount: 0, message: "scope 'pair' requires both model and credential." };
      }
      return this.resetScoped(target.modelId, target.keyHashPrefix);
    }

    // credential: every tuple breaker of this credential. SUSPECT is NOT cleared here —
    // it needs the explicit clear endpoint (administrative, not a cooldown).
    if (!target.keyHashPrefix) {
      return { resetCount: 0, message: "scope 'credential' requires an credential (keyHashPrefix)." };
    }
    // Direct breaker.reset() calls bypass the hooked reset/resetScoped
    // entry points, so arm the debounced snapshot here.
    this.schedulePersist();
    let count = 0;
    for (const tuple of this.tuples.values()) {
      if (tuple.keyHashPrefix !== target.keyHashPrefix) continue;
      if (target.providerId && tuple.provider !== target.providerId) continue;
      tuple.breaker.reset();
      count++;
    }
    return {
      resetCount: count,
      message: count
        ? `Reset ${count} pair breaker(s) for credential '${target.keyHashPrefix}'.`
        : `No pair breakers found for credential '${target.keyHashPrefix}'.`,
    };
  }

  /**
   * Manually trip a MODEL: every tuple breaker of the model goes OPEN (admin
   * takes it out of rotation from the console). Persisted with the rest of
   * the breaker memory: the trip survives a restart until its cooldown
   * expires; for a permanent exclusion still use the exclude lists
   * (config.tiers).
   */
  public trip(
    modelId: string,
    options?: ManualTripOptions,
    provider = 'unknown',
    chainPrefixes?: readonly string[]
  ): TripResult {
    this.schedulePersist();
    const targets = this.modelTupleTargets(modelId, provider, chainPrefixes);
    const cooldownMs = this.manualCooldownMs(options);
    for (const tuple of targets) {
      tuple.lastScope = 'model';
      tuple.breaker.trip(`Manual trip: ${this.manualReason(options)}`, 'MANUAL', cooldownMs, 'breaker.manual', this.manualTripParams(options));
    }
    return {
      tripped: targets.length > 0,
      affected: targets.length,
      message:
        `Circuit breaker for model '${modelId}' manually tripped (OPEN) on ${targets.length} credential(s) ` +
        `for ${CircuitBreakerManager.minutes(cooldownMs)}.`,
    };
  }

  private manualCooldownMs(options?: ManualTripOptions): number {
    return Math.max(
      1000,
      Math.min(options?.cooldownMs ?? MANUAL_TRIP_DEFAULT_COOLDOWN_MS, MANUAL_TRIP_MAX_COOLDOWN_MS)
    );
  }

  private manualReason(options?: ManualTripOptions): string {
    return options?.reason?.trim() || 'Manual trip via console';
  }

  /** Empty `detail` = console default (the console renders a dedicated label). */
  private manualTripParams(options?: ManualTripOptions): ReasonParams {
    return { detail: options?.reason?.trim() ?? '' };
  }

  /** Human cooldown label shared by the manual trip messages. */
  private static minutes(cooldownMs: number): string {
    return `~${Math.round(cooldownMs / 60000)} min`;
  }

  /** Manual trip of a single (model, credential) tuple. */
  public tripPair(
    modelId: string,
    keyHashPrefix: string,
    options?: ManualTripOptions,
    provider?: string
  ): TripResult {
    this.schedulePersist();
    const tuple = this.getOrCreateTuple(modelId, keyHashPrefix, provider);
    const cooldownMs = this.manualCooldownMs(options);
    tuple.lastScope = 'pair';
    tuple.breaker.trip(`Manual trip: ${this.manualReason(options)}`, 'MANUAL', cooldownMs, 'breaker.manual', this.manualTripParams(options));
    return {
      tripped: true,
      affected: 1,
      message:
        `Circuit breaker for model '${modelId}' on credential '${keyHashPrefix}' ` +
        `manually tripped (OPEN) for ${CircuitBreakerManager.minutes(cooldownMs)}.`,
    };
  }

  /**
   * Manually trip a whole credential (one credential across the models it can reach).
   * No SUSPECT mark: a manual trip is a temporary takedown with a cooldown,
   * while SUSPECT is the administrative state an operator must clear by hand.
   */
  public tripCredential(
    keyHashPrefix: string,
    options?: ManualTripOptions,
    providerId?: string
  ): TripResult {
    this.schedulePersist();
    const cooldownMs = this.manualCooldownMs(options);
    const reason = `Manual trip: ${this.manualReason(options)}`;
    // Without an explicit provider the credential's owner(s) are whatever the
    // existing tuple breakers say — a prefix is only ever seen through a provider.
    const owners = new Set<string>();
    if (providerId) owners.add(providerId);
    // When a provider IS given, expansion honors it too — another provider's
    // tuples sharing the same prefix must not mislabel created tuples' owner.
    for (const tuple of this.tuples.values()) {
      if (tuple.keyHashPrefix === keyHashPrefix && (!providerId || tuple.provider === providerId)) {
        owners.add(tuple.provider);
      }
    }

    const targets = new Set<string>();
    for (const tuple of this.tuples.values()) {
      if (tuple.keyHashPrefix === keyHashPrefix && (!providerId || tuple.provider === providerId)) {
        targets.add(tuple.modelId);
      }
    }
    for (const owner of owners) {
      for (const modelId of this.credentialModelIds(owner, keyHashPrefix)) targets.add(modelId);
    }
    for (const modelId of targets) {
      const tuple = this.getOrCreateTuple(modelId, keyHashPrefix, providerId);
      tuple.lastScope = 'credential';
      tuple.breaker.trip(reason, 'MANUAL', cooldownMs, 'breaker.manual', this.manualTripParams(options));
    }
    const label = CircuitBreakerManager.minutes(cooldownMs);
    return {
      tripped: targets.size > 0,
      affected: targets.size,
      message: targets.size
        ? `Credential '${keyHashPrefix}' tripped (OPEN) on ${targets.size} model(s) for ${label}.`
        : `Credential '${keyHashPrefix}' has no pair breakers to trip (unknown provider or no models registered).`,
    };
  }

  /**
   * Manual (console/REST) trip with explicit scope. `model` is the legacy
   * scope and stays the default; `credential` and `pair` address the finer grain.
   * `affected` counts the breakers actually taken down, so a caller can tell a
   * no-op (unknown credential) from a real trip without parsing prose.
   */
  public tripByScope(scope: TripScope, target: ScopeTarget, options?: ManualTripOptions): TripResult {
    if (scope === 'model') {
      if (!target.modelId) {
        return { tripped: false, affected: 0, message: "scope 'model' requires a model." };
      }
      return this.trip(target.modelId, options, target.providerId ?? 'unknown', target.chainPrefixes);
    }
    if (scope === 'pair') {
      if (!target.modelId || !target.keyHashPrefix) {
        return { tripped: false, affected: 0, message: "scope 'pair' requires both model and credential." };
      }
      return this.tripPair(target.modelId, target.keyHashPrefix, options, target.providerId);
    }
    if (!target.keyHashPrefix) {
      return { tripped: false, affected: 0, message: "scope 'credential' requires an credential (keyHashPrefix)." };
    }
    return this.tripCredential(target.keyHashPrefix, options, target.providerId);
  }

  /**
   * DERIVED model view: the worst-state fold over the model's tuple breakers
   * (OPEN > HALF_OPEN > CLOSED). The model level has no state machine of its
   * own — this fold exists so existing summary consumers (health endpoint,
   * console matrix) keep one row per model. A model with no tuples yet folds
   * to a clean CLOSED snapshot.
   */
  private foldedModelSnapshot(modelId: string): CircuitBreakerSnapshot {
    let worst: { snap: CircuitBreakerSnapshot; scope: TripScope | undefined } | undefined;
    for (const tuple of this.tuples.values()) {
      if (tuple.modelId !== modelId) continue;
      const snap = tuple.breaker.getSnapshot();
      if (!worst || STATE_SEVERITY[snap.state] > STATE_SEVERITY[worst.snap.state]) {
        worst = { snap, scope: tuple.lastScope };
      } else if (snap.state === worst.snap.state && snap.consecutiveFailures > worst.snap.consecutiveFailures) {
        worst = { snap, scope: tuple.lastScope };
      }
    }
    const base: CircuitBreakerSnapshot = {
      modelId,
      provider: this.modelProviders.get(modelId) ?? 'unknown',
      tier: this.modelTiers.get(modelId),
      state: 'CLOSED',
      consecutiveFailures: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      remainingCooldownMs: 0,
      currentCooldownMs: 0,
      halfOpenProbes: 0,
      halfOpenSuccesses: 0,
    };
    if (!worst) return base;
    return { ...base, ...worst.snap, modelId, scope: worst.scope };
  }

  public getSnapshot(modelId: string): CircuitBreakerSnapshot | undefined {
    if (!this.modelProviders.has(modelId)) return undefined;
    return this.foldedModelSnapshot(modelId);
  }

  public getAllSnapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.modelProviders.keys(), (modelId) => this.foldedModelSnapshot(modelId));
  }

  /**
   * Tuple-breaker snapshots — the view a scope-aware console/prober reads.
   * Every snapshot carries `keyHashPrefix` (the chain-less sentinel surfaces
   * as `''`). Model-level rows are the derived fold in `getAllSnapshots()`.
   */
  public snapshotsWithPairs(): CircuitBreakerSnapshot[] {
    return Array.from(this.tuples.values(), (tuple) => ({
      ...tuple.breaker.getSnapshot(),
      keyHashPrefix: tuple.keyHashPrefix,
      scope: tuple.lastScope,
    }));
  }

  /**
   * Tuple-only summary (every snapshot here carries `keyHashPrefix`). The
   * console status payload ships this as `circuitBreakers.pairs` so the
   * guardrails view renders the credential-scoped layer.
   */
  public getPairSummary(): CircuitBreakerSummary {
    const snapshots = this.snapshotsWithPairs();
    return {
      object: 'circuit_breaker_summary',
      total: snapshots.length,
      healthy: snapshots.filter(s => s.state === 'CLOSED').length,
      tripped: snapshots.filter(s => s.state === 'OPEN').length,
      halfOpen: snapshots.filter(s => s.state === 'HALF_OPEN').length,
      breakers: snapshots,
    };
  }

  public getSummary(): CircuitBreakerSummary {
    const snapshots = this.getAllSnapshots();
    const healthy = snapshots.filter(s => s.state === 'CLOSED').length;
    const tripped = snapshots.filter(s => s.state === 'OPEN').length;
    const halfOpen = snapshots.filter(s => s.state === 'HALF_OPEN').length;

    return {
      object: 'circuit_breaker_summary',
      total: snapshots.length,
      healthy,
      tripped,
      halfOpen,
      breakers: snapshots,
    };
  }
}
