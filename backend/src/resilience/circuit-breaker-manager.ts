import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  resolveBreakerRules,
} from './circuit-breaker.js';
import { BreakerStateStore } from './breaker-state.js';
import { AccountStateStore, defaultAccountStateStore } from './account-state.js';
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
}

/** Gate verdict of a model or (model, credential) breaker — same shape as `canExecute`. */
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

/** Aggregate availability of one model-level breaker, with the accounts that are out of it. */
export interface ModelAvailability {
  available: boolean;
  /** Candidate prefixes that cannot serve: pair OPEN/unavailable, or account SUSPECT. */
  openPrefixes: string[];
}

/** One (model × credential) breaker plus the identity it is keyed by. */
interface PairRecord {
  modelId: string;
  keyHashPrefix: string;
  provider: string;
  breaker: CircuitBreaker;
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

/**
 * Circuit breaker registry with scoped breakers.
 *
 *   bare-modelId breaker          == model scope   (this model, every credential)
 *   `${modelId}::${keyHashPrefix}` == pair scope    (this model, this credential)
 *   all pairs of one credential    == account scope (this credential, every model)
 *
 * A provider whose chain has a single credential never gets pair breakers: the caller
 * omits `keyHashPrefix` and every path degenerates to the bare-modelId breaker
 * — byte-identical to the legacy single-credential behavior.
 *
 * With a `BreakerStateStore` attached (boot path only) the whole registry also has
 * an on-disk memory: cooldowns, backoff position and manual
 * trips survive a gateway restart. Without one it stays purely in-memory.
 */
export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreaker>();
  private pairs = new Map<string, PairRecord>();
  // modelId -> provider, so account-wide expansion and SUSPECT lookups can name the
  // account owner even for pair breakers created lazily on a failure path.
  private modelProviders = new Map<string, string>();
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
  private accountState: AccountStateStore;
  // optional on-disk breaker memory.
  // Undefined = pure in-memory (every test harness and any registry the boot
  // path never attaches a store to; behavior is byte-identical to pre-P3).
  private stateStore: BreakerStateStore | undefined;

  constructor(
    config?: CircuitBreakerConfig,
    nowFn: () => number = Date.now,
    accountState?: AccountStateStore,
    // Only consulted for trip.rateLimit.hardTripAboveMs's default
    // (retry.inplace.maxRateLimitWaitMs); the breaker side never rewrites the
    // retry-side in-place-retry decision.
    retryConfig?: RetryConfig
  ) {
    this.config = config || {};
    this.rules = resolveBreakerRules(this.config, retryConfig);
    this.nowFn = nowFn;
    this.accountState = accountState ?? defaultAccountStateStore();
  }

  /**
   * Hot-apply a new circuitBreaker config (spec invariant 6, hot-apply):
   * re-resolve the effective ruleset, swap it into the gate, and push config
   * + the new rules into every live breaker (model AND pair). Breaker STATE is
   * never touched by the swap — the new rules govern from the next decision
   * point — except the invariant-2 reconciliation below. `retryConfig` is
   * consulted only for `hardTripAboveMs`'s default, exactly like boot.
   * Deliberately NOT hot-applied here: `persistence.debounceMs` (the
   * BreakerStateStore binds its debounce at construction, boot path).
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
    for (const breaker of this.breakers.values()) settle(breaker);
    for (const pair of this.pairs.values()) settle(pair.breaker);
  }

  public registerModel(model: ModelRegistration): CircuitBreaker {
    this.modelProviders.set(model.id, model.provider);
    let breaker = this.breakers.get(model.id);
    if (!breaker) {
      breaker = new CircuitBreaker(
        model.id,
        model.provider,
        model.tier,
        this.config,
        this.nowFn,
        this.rules
      );
      this.breakers.set(model.id, breaker);
    }
    return breaker;
  }

  public getBreaker(modelId: string): CircuitBreaker | undefined {
    return this.breakers.get(modelId);
  }

  public getOrCreateBreaker(
    modelId: string,
    provider = 'unknown',
    tier?: any
  ): CircuitBreaker {
    if (!this.modelProviders.has(modelId)) this.modelProviders.set(modelId, provider);
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      breaker = new CircuitBreaker(modelId, provider, tier, this.config, this.nowFn, this.rules);
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

  /** The pair breaker for (model, credential), or undefined if none exists. */
  public getPairBreaker(modelId: string, keyHashPrefix: string): CircuitBreaker | undefined {
    return this.pairs.get(pairKey(modelId, keyHashPrefix))?.breaker;
  }

  /**
   * Models this registry knows for a provider — the model set an account-wide
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
   * Models an account-wide trip of (provider, credential) covers: everything
   * registered for that provider, plus any model that already carries a pair
   * breaker for the account (a pair can outlive a provider re-index).
   */
  private accountModelIds(providerId: string, keyHashPrefix: string): string[] {
    const out = new Set<string>(this.modelsOfProvider(providerId));
    for (const pair of this.pairs.values()) {
      if (pair.keyHashPrefix === keyHashPrefix && pair.provider === providerId) out.add(pair.modelId);
    }
    return Array.from(out);
  }

  /**
   * Trial-call budget per model per prober cycle (Decision 6 reuses the
   * HALF_OPEN trial budget, so pair fan-out cannot multiply background load).
   * = rules.recovery.halfOpen.maxProbes, defaulting to halfOpenMaxProbes.
   */
  public getProbeBudget(): number {
    return this.rules.recovery.halfOpen.maxProbes;
  }

  private getOrCreatePair(modelId: string, keyHashPrefix: string, provider?: string): PairRecord {
    const key = pairKey(modelId, keyHashPrefix);
    let pair = this.pairs.get(key);
    if (!pair) {
      const owner = this.resolveProvider(modelId, provider);
      pair = {
        modelId,
        keyHashPrefix,
        provider: owner,
        breaker: new CircuitBreaker(
          modelId,
          owner,
          this.breakers.get(modelId)?.tier,
          this.config,
          this.nowFn,
          this.rules
        ),
      };
      this.pairs.set(key, pair);
    }
    return pair;
  }

  public canExecute(modelId: string): { allowed: boolean; reason?: string; state: CircuitBreakerState } {
    const breaker = this.breakers.get(modelId);
    if (!breaker) {
      return { allowed: true, state: 'CLOSED' };
    }
    const check = breaker.canExecute();
    return {
      allowed: check.allowed,
      reason: check.reason,
      state: breaker.getState(),
    };
  }

  /**
   * CONSUMING gate at the finest attributed scope.
   * No `keyHashPrefix` (single-credential provider) is exactly `canExecute(modelId)`.
   * With a prefix the model breaker is only PEEKED and the pair breaker consumes
   * the canary slot. Consuming the model slot here would strand it: a pair-scope
   * verdict deliberately never reaches the model breaker, so a HALF_OPEN model
   * whose slot was spent on a request that came back 429-on-one-account would
   * sit with an exhausted quota while every account stayed healthy. Pair scope
   * therefore bounds background traffic by (accounts x the HALF_OPEN trial
   * budget) instead, and a pair success counts as a model trial success
   * (see `recordSuccessScoped` — closes only at recovery.halfOpen.successThreshold).
   */
  public canExecuteScoped(modelId: string, keyHashPrefix?: string): BreakerGate {
    if (!keyHashPrefix) {
      return this.canExecute(modelId);
    }

    const modelBreaker = this.breakers.get(modelId);
    if (modelBreaker) {
      const peek = modelBreaker.peekExecute();
      if (!peek.allowed) {
        return { allowed: false, reason: peek.reason, state: modelBreaker.getState() };
      }
    }

    const pair = this.pairs.get(pairKey(modelId, keyHashPrefix));
    if (this.isSuspect(modelId, keyHashPrefix)) {
      return {
        allowed: false,
        reason:
          `Account '${keyHashPrefix}' is SUSPECT for model '${modelId}' ` +
          '(confirmed-bad credential; reconnect or clear to restore).',
        state: pair ? pair.breaker.getState() : 'OPEN',
      };
    }
    if (!pair) {
      // No pair state = never failed on this account: the model breaker already said yes.
      return { allowed: true, state: modelBreaker ? modelBreaker.getState() : 'CLOSED' };
    }
    const check = pair.breaker.canExecute();
    return { allowed: check.allowed, reason: check.reason, state: pair.breaker.getState() };
  }

  /**
   * NON-CONSUMING availability check (peek) — safe for selection, filtering
   * and introspection; never takes a HALF_OPEN probe slot. The consuming
   * gate is getBreaker(modelId)?.canExecute() at the execution site only.
   */
  public isAvailable(modelId: string): boolean {
    const breaker = this.breakers.get(modelId);
    if (!breaker) {
      return true;
    }
    return breaker.peekExecute().allowed;
  }

  /**
   * The derived aggregate the pool builders will read:
   * a model is available iff its model breaker is CLOSED/HALF_OPEN-capable AND
   * at least one candidate credential serves (its pair breaker not OPEN, its
   * account not SUSPECT). A down model breaker reports every candidate unusable
   * (the pair breakers themselves may all be healthy — the model is what
   * failed); an empty `candidatePrefixes` (no chain registered) degenerates to
   * the model-breaker check alone, never to "unavailable", which is what keeps
   * single-credential providers intact.
   */
  public modelAvailability(modelId: string, candidatePrefixes: string[]): ModelAvailability {
    if (!this.isAvailable(modelId)) {
      return { available: false, openPrefixes: [...candidatePrefixes] };
    }
    if (candidatePrefixes.length === 0) {
      return { available: true, openPrefixes: [] };
    }

    const openPrefixes: string[] = [];
    for (const prefix of candidatePrefixes) {
      if (this.isPairOut(modelId, prefix)) {
        openPrefixes.push(prefix);
      }
    }
    return { available: openPrefixes.length < candidatePrefixes.length, openPrefixes };
  }

  /** Administrative SUSPECT flag for the account this model belongs to. */
  public isSuspect(modelId: string, keyHashPrefix: string): boolean {
    const providerId = this.resolveProvider(modelId);
    if (providerId === 'unknown') return false;
    return this.accountState.isSuspect(providerId, keyHashPrefix);
  }

  /**
   * Operator takedown for the account this model belongs to. Unlike SUSPECT it is
   * never set or lifted by runtime evidence — only the console (or the REST twin)
   * flips it, and it survives reconnect, Push and every cooldown.
   */
  public isDisabled(modelId: string, keyHashPrefix: string): boolean {
    const providerId = this.resolveProvider(modelId);
    if (providerId === 'unknown') return false;
    return this.accountState.isDisabled(providerId, keyHashPrefix);
  }

  /**
   * The single NON-CONSUMING "out of service" predicate
   * for one (model, credential) pair: account SUSPECT, or its pair breaker
   * currently not peek-allowed. NEVER takes a HALF_OPEN probe slot — the
   * consuming gate is `canExecuteScoped()` at the execution site only.
   * Selection (account-selection.ts), the prober plan (health-prober.ts) and
   * `modelAvailability()` below all route through this one implementation.
   */
  public isPairOut(modelId: string, keyHashPrefix: string): boolean {
    // Operator takedown outranks every runtime signal: it is the one state that
    // NEVER auto-returns, so it is checked first and shared by all three
    // consumers (selection, prober plan, model availability) through this gate.
    if (this.isDisabled(modelId, keyHashPrefix)) return true;
    if (this.isSuspect(modelId, keyHashPrefix)) return true;
    const pair = this.pairs.get(pairKey(modelId, keyHashPrefix));
    return pair !== undefined && !pair.breaker.peekExecute().allowed;
  }

  public getAccountStateStore(): AccountStateStore {
    return this.accountState;
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
   * Rehydrate breakers from disk. Records for models the registry no longer
   * knows (config removed/renamed them over the restart) are DROPPED, so the
   * file self-cleans and removed models never ghost through snapshots or
   * account-wide trip expansion. OPEN records whose reasonCode belongs to a
   * now-disabled trip rule are skipped too — the startup reconciliation of
   * spec invariant 2: closing a rule must not resurrect a cooldown nobody
   * asked for (the same filter runs live in `applyConfig` at every hot-apply,
   * invariant 6). Returns the applied counts.
   */
  public restoreState(): { models: number; pairs: number } {
    const file = this.stateStore?.load();
    if (!file) return { models: 0, pairs: 0 };
    const disabled = CircuitBreakerManager.disabledTripReasonCodes(this.rules);
    const revived = (rec: BreakerRecord): boolean =>
      rec.state === 'OPEN' && rec.reasonCode !== undefined && disabled.has(rec.reasonCode);
    let models = 0;
    for (const rec of file.models) {
      if (!this.modelProviders.has(rec.modelId) || revived(rec)) continue;
      // Identity (provider/tier) comes from the CURRENT config, not the file.
      const breaker = this.getOrCreateBreaker(rec.modelId, this.modelProviders.get(rec.modelId));
      breaker.applyRecord(rec);
      models++;
    }
    let pairs = 0;
    for (const rec of file.pairs) {
      if (!rec.keyHashPrefix || !this.modelProviders.has(rec.modelId) || revived(rec)) continue;
      // getOrCreatePair resolves the owner from the registry (resolveProvider).
      const pair = this.getOrCreatePair(rec.modelId, rec.keyHashPrefix);
      pair.breaker.applyRecord(rec);
      pairs++;
    }
    return { models, pairs };
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

  /** The live full-state file (called by the debounced store, never hot-path). */
  private buildStateFile(): BreakerStateFile {
    return {
      version: 1,
      savedAt: this.nowFn(),
      models: Array.from(this.breakers.values(), b => b.toRecord()),
      pairs: Array.from(this.pairs.values(), p => ({
        ...p.breaker.toRecord(),
        keyHashPrefix: p.keyHashPrefix,
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

  public recordSuccess(modelId: string): void {
    this.schedulePersist();
    const breaker = this.breakers.get(modelId);
    if (breaker) {
      breaker.recordSuccess();
    }
  }

  /** Provider owner of a model as this registry knows it ('unknown' when never seen). */
  private resolveProvider(modelId: string, provider?: string): string {
    if (provider && provider !== 'unknown') return provider;
    return this.modelProviders.get(modelId) ?? this.breakers.get(modelId)?.provider ?? 'unknown';
  }

  /**
   * Success for one (model, credential). Without a
   * prefix this is today's `recordSuccess(modelId)`. With one, the pair breaker
   * recovers and a HALF_OPEN model breaker gets a TRIAL SUCCESS: the scoped
   * gate peeks the model breaker instead of consuming its slot, so a
   * recovering model needs an explicit closer and any credential that answers
   * proves the upstream is back. With successThreshold > 1 this counts toward
   * the model's trial batch (the batch closes at the threshold), it does NOT
   * force-close (spec rule #10 interaction note).
   */
  public recordSuccessScoped(modelId: string, keyHashPrefix?: string, provider?: string): void {
    this.schedulePersist();
    if (!keyHashPrefix) {
      this.recordSuccess(modelId);
      return;
    }
    const owner = this.resolveProvider(modelId, provider);
    const pair = this.pairs.get(pairKey(modelId, keyHashPrefix));
    if (pair) {
      pair.breaker.recordSuccess();
    } else if (owner !== 'unknown') {
      // A success on a never-failed pair still has to name the owner, or the
      // account-wide expansion would not know which provider this model belongs to.
      this.getOrCreatePair(modelId, keyHashPrefix, owner);
    }
    const modelBreaker = this.breakers.get(modelId);
    if (modelBreaker && modelBreaker.getState() === 'HALF_OPEN') {
      modelBreaker.recordSuccess();
    }
  }

  public recordFailure(modelId: string, diagnosis: ErrorDiagnosis, provider = 'unknown'): void {
    this.schedulePersist();
    this.applyFailure(modelId, diagnosis, provider, undefined);
  }

  /**
   * Record a failure and EXPAND it over the blast radius
   * the rule gate resolved. Without a prefix (or without a `tripScope`, which
   * only ever exists under credential attribution) the diagnosis goes to the
   * bare-modelId breaker, exactly as before P3.
   *
   *   'pair'    -> this (model, credential) only
   *   'account' -> every model this credential can reach; SUSPECT if diagnosed
   *   'model'   -> the bare-modelId breaker (aggregation takes the model down)
   *
   * A rule `scope` override replaces the classifier's blast radius here —
   * AFTER credential attribution (invariant 4): with no prefix there is no
   * pair space to expand into, so chain-less providers keep degenerating to
   * the model breaker no matter what an override says.
   *
   * Pair and account verdicts deliberately do NOT touch the model breaker:
   * credential-scoped failures are not evidence about the model, and cooling a
   * model because one of its credentials hit a limit is the flaw this design
   * removes.
   */
  public recordFailureScoped(
    modelId: string,
    diagnosis: ErrorDiagnosis,
    provider?: string,
    keyHashPrefix?: string
  ): void {
    this.schedulePersist();
    if (!keyHashPrefix) {
      this.applyFailure(modelId, diagnosis, provider ?? 'unknown', undefined);
      return;
    }
    this.applyFailure(modelId, diagnosis, provider, keyHashPrefix);
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
   *   - the effective `scope` override picks the blast radius (account
   *     expansion needs the attribution this call site already has).
   *
   * Never rewrites category/isRetriable (invariant 3): adjustments ride on a
   * copy, the caller's diagnosis object stays untouched.
   */
  private applyFailure(
    modelId: string,
    diagnosis: ErrorDiagnosis,
    provider?: string,
    keyHashPrefix?: string
  ): void {
    const r = this.rules;
    const owner = this.resolveProvider(modelId, provider);
    const dispatch = this.dispatchFailure(diagnosis);
    const deliver = (breaker: CircuitBreaker): void => {
      switch (dispatch.kind) {
        case 'drop':
          breaker.releaseProbeSlot();
          return;
        case 'hard':
          breaker.recordHardTrip(diagnosis, dispatch.cooldownMs);
          return;
        case 'count':
          breaker.recordFailure(dispatch.diagnosis);
          return;
        default:
          breaker.recordFailure(diagnosis);
      }
    };

    const scope = this.effectiveScope(diagnosis);
    if (scope === 'model' || !keyHashPrefix) {
      deliver(this.getOrCreateBreaker(modelId, owner));
      return;
    }
    if (scope === 'pair') {
      deliver(this.getOrCreatePair(modelId, keyHashPrefix, owner).breaker);
      return;
    }
    // account-wide: the credential is the problem, on every model it can serve.
    if (!this.modelProviders.has(modelId)) this.modelProviders.set(modelId, owner);
    const rowTargets = new Set(this.accountModelIds(owner, keyHashPrefix));
    rowTargets.add(modelId);
    for (const targetId of rowTargets) {
      deliver(this.getOrCreatePair(targetId, keyHashPrefix, owner).breaker);
    }
    // SUSPECT is administrative and auth-only: quota recovers by itself, a
    // dead key does not (Decision 6). The flag rides on the trip (spec: mark
    // SUSPECT "on trip"): with the auth rule OFF the 401 is "ignore" (rule
    // semantics #2 — neither trips nor counts), so nothing is flagged. Manual
    // trips never set it, and trip.auth.markSuspect:false stops NEW flags
    // only — existing suspect-accounts.json entries keep gating selection
    // until operator clear (invariant 2: toggles never clear existing flags).
    if (diagnosis.accountSuspect && r.trip.auth.enabled && r.trip.auth.markSuspect) {
      this.accountState.mark(owner, keyHashPrefix, diagnosis.reason);
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
   * Manual reset. `modelId` = the model's breaker AND that model's pair
   * breakers (an operator
   * putting a model back in service does not want a stale account cooldown to
   * keep the aggregate down). SUSPECT is the separate administrative gate and
   * survives every reset path — only `AccountStateStore.clear()` lifts it.
   * No argument resets every model breaker and every pair breaker.
   */
  public reset(modelId?: string): { resetCount: number; message: string } {
    this.schedulePersist();
    if (modelId) {
      const breaker = this.breakers.get(modelId);
      let count = 0;
      if (breaker) {
        breaker.reset();
        count = 1;
      }
      for (const pair of this.pairs.values()) {
        if (pair.modelId !== modelId) continue;
        pair.breaker.reset();
        count++;
      }
      if (count === 0) {
        return { resetCount: 0, message: `Model '${modelId}' not found in circuit breaker registry.` };
      }
      return { resetCount: count, message: `Circuit breaker for model '${modelId}' reset to CLOSED.` };
    }

    let count = 0;
    for (const breaker of this.breakers.values()) {
      breaker.reset();
      count++;
    }
    for (const pair of this.pairs.values()) {
      pair.breaker.reset();
      count++;
    }
    return { resetCount: count, message: `All ${count} circuit breakers successfully reset to CLOSED.` };
  }

  /** Reset one (model, credential) pair; no prefix degenerates to `reset(modelId)`. */
  public resetScoped(modelId: string, keyHashPrefix?: string): { resetCount: number; message: string } {
    if (!keyHashPrefix) return this.reset(modelId);
    this.schedulePersist();
    const pair = this.pairs.get(pairKey(modelId, keyHashPrefix));
    if (!pair) {
      return { resetCount: 0, message: `No pair breaker for model '${modelId}' on account '${keyHashPrefix}'.` };
    }
    pair.breaker.reset();
    return {
      resetCount: 1,
      message: `Circuit breaker for model '${modelId}' on account '${keyHashPrefix}' reset to CLOSED.`,
    };
  }

  /** Reset the scope a manual operator action names (see `tripByScope`). */
  public resetByScope(scope: TripScope, target: ScopeTarget): { resetCount: number; message: string } {
    if (scope === 'model') return this.reset(target.modelId);

    if (scope === 'pair') {
      if (!target.modelId || !target.keyHashPrefix) {
        return { resetCount: 0, message: "scope 'pair' requires both model and account." };
      }
      return this.resetScoped(target.modelId, target.keyHashPrefix);
    }

    // account: every pair breaker of this credential. SUSPECT is NOT cleared here —
    // it needs the explicit clear endpoint (administrative, not a cooldown).
    if (!target.keyHashPrefix) {
      return { resetCount: 0, message: "scope 'account' requires an account (keyHashPrefix)." };
    }
    // Direct breaker.reset() calls bypass the hooked reset/resetScoped
    // entry points, so arm the debounced snapshot here.
    this.schedulePersist();
    let count = 0;
    for (const pair of this.pairs.values()) {
      if (pair.keyHashPrefix !== target.keyHashPrefix) continue;
      if (target.providerId && pair.provider !== target.providerId) continue;
      pair.breaker.reset();
      count++;
    }
    return {
      resetCount: count,
      message: count
        ? `Reset ${count} pair breaker(s) for account '${target.keyHashPrefix}'.`
        : `No pair breakers found for account '${target.keyHashPrefix}'.`,
    };
  }

  /**
   * Manually trip a model's breaker into OPEN (admin takes it out of
   * rotation from the console). Persisted with the rest of the breaker
   * memory: the trip survives a restart until its
   * cooldown expires; for a permanent exclusion still use the exclude
   * lists (config.tiers).
   */
  public trip(modelId: string, options?: ManualTripOptions, provider = 'unknown'): TripResult {
    this.schedulePersist();
    const breaker = this.getOrCreateBreaker(modelId, provider);
    const cooldownMs = this.manualCooldownMs(options);
    breaker.trip(`Manual trip: ${this.manualReason(options)}`, 'MANUAL', cooldownMs, 'breaker.manual', this.manualTripParams(options));
    return {
      tripped: true,
      affected: 1,
      message:
        `Circuit breaker for model '${modelId}' manually tripped (OPEN) ` +
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

  /** Manual trip of a single (model, credential) pair. */
  public tripPair(
    modelId: string,
    keyHashPrefix: string,
    options?: ManualTripOptions,
    provider?: string
  ): TripResult {
    this.schedulePersist();
    const pair = this.getOrCreatePair(modelId, keyHashPrefix, provider);
    const cooldownMs = this.manualCooldownMs(options);
    pair.breaker.trip(`Manual trip: ${this.manualReason(options)}`, 'MANUAL', cooldownMs, 'breaker.manual', this.manualTripParams(options));
    return {
      tripped: true,
      affected: 1,
      message:
        `Circuit breaker for model '${modelId}' on account '${keyHashPrefix}' ` +
        `manually tripped (OPEN) for ${CircuitBreakerManager.minutes(cooldownMs)}.`,
    };
  }

  /**
   * Manually trip a whole account (one credential across the models it can reach).
   * No SUSPECT mark: a manual trip is a temporary takedown with a cooldown,
   * while SUSPECT is the administrative state an operator must clear by hand.
   */
  public tripAccount(
    keyHashPrefix: string,
    options?: ManualTripOptions,
    providerId?: string
  ): TripResult {
    this.schedulePersist();
    const cooldownMs = this.manualCooldownMs(options);
    const reason = `Manual trip: ${this.manualReason(options)}`;
    // Without an explicit provider the account's owner(s) are whatever the
    // existing pair breakers say — a prefix is only ever seen through a provider.
    const owners = new Set<string>();
    if (providerId) owners.add(providerId);
    for (const pair of this.pairs.values()) {
      if (pair.keyHashPrefix === keyHashPrefix) owners.add(pair.provider);
    }

    const targets = new Set<string>();
    for (const pair of this.pairs.values()) {
      if (pair.keyHashPrefix === keyHashPrefix && (!providerId || pair.provider === providerId)) {
        targets.add(pair.modelId);
      }
    }
    for (const owner of owners) {
      for (const modelId of this.accountModelIds(owner, keyHashPrefix)) targets.add(modelId);
    }
    for (const modelId of targets) {
      this.getOrCreatePair(modelId, keyHashPrefix, providerId).breaker.trip(
        reason,
        'MANUAL',
        cooldownMs,
        'breaker.manual',
        this.manualTripParams(options)
      );
    }
    const label = CircuitBreakerManager.minutes(cooldownMs);
    return {
      tripped: targets.size > 0,
      affected: targets.size,
      message: targets.size
        ? `Account '${keyHashPrefix}' tripped (OPEN) on ${targets.size} model(s) for ${label}.`
        : `Account '${keyHashPrefix}' has no pair breakers to trip (unknown provider or no models registered).`,
    };
  }

  /**
   * Manual (console/REST) trip with explicit scope. `model` is the legacy
   * scope and stays the default; `account` and `pair` address the finer grain.
   * `affected` counts the breakers actually taken down, so a caller can tell a
   * no-op (unknown account) from a real trip without parsing prose.
   */
  public tripByScope(scope: TripScope, target: ScopeTarget, options?: ManualTripOptions): TripResult {
    if (scope === 'model') {
      if (!target.modelId) {
        return { tripped: false, affected: 0, message: "scope 'model' requires a model." };
      }
      return this.trip(target.modelId, options, target.providerId ?? 'unknown');
    }
    if (scope === 'pair') {
      if (!target.modelId || !target.keyHashPrefix) {
        return { tripped: false, affected: 0, message: "scope 'pair' requires both model and account." };
      }
      return this.tripPair(target.modelId, target.keyHashPrefix, options, target.providerId);
    }
    if (!target.keyHashPrefix) {
      return { tripped: false, affected: 0, message: "scope 'account' requires an account (keyHashPrefix)." };
    }
    return this.tripAccount(target.keyHashPrefix, options, target.providerId);
  }

  public getSnapshot(modelId: string): CircuitBreakerSnapshot | undefined {
    return this.breakers.get(modelId)?.getSnapshot();
  }

  public getAllSnapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values()).map(b => b.getSnapshot());
  }

  /**
   * Model AND pair breaker snapshots — the view a scope-aware console/prober
   * reads. Pair snapshots carry `keyHashPrefix`; model snapshots never do, so
   * readers can filter with `snapshots.filter(s => !s.keyHashPrefix)`.
   */
  public snapshotsWithPairs(): CircuitBreakerSnapshot[] {
    const out: CircuitBreakerSnapshot[] = [];
    for (const breaker of this.breakers.values()) out.push(breaker.getSnapshot());
    for (const pair of this.pairs.values()) {
      out.push({ ...pair.breaker.getSnapshot(), keyHashPrefix: pair.keyHashPrefix });
    }
    return out;
  }

  /**
   * Pair-only summary (every snapshot here carries `keyHashPrefix`). Additive
   * companion to `getSummary()` — the model-only contract pinned by
   * resilience-pairs tests stays untouched; the console status payload ships
   * this as `circuitBreakers.pairs` so the guardrails view can render the
   * credential-scoped layer without changing any existing consumer's numbers.
   */
  public getPairSummary(): CircuitBreakerSummary {
    const snapshots = this.snapshotsWithPairs().filter(s => s.keyHashPrefix !== undefined);
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
