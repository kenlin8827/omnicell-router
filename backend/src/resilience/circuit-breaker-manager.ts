import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from './circuit-breaker.js';
import { AccountStateStore, defaultAccountStateStore } from './account-state.js';
import {
  CircuitBreakerConfig,
  CircuitBreakerSnapshot,
  CircuitBreakerState,
  ErrorDiagnosis,
  TripScope,
} from './types.js';
import { ModelRegistration } from '../config/types.js';

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

function pairKey(modelId: string, keyHashPrefix: string): string {
  return `${modelId}::${keyHashPrefix}`;
}

/**
 * Circuit breaker registry with ADR-0019 Decision 6 scoped breakers.
 *
 *   bare-modelId breaker          == model scope   (this model, every credential)
 *   `${modelId}::${keyHashPrefix}` == pair scope    (this model, this credential)
 *   all pairs of one credential    == account scope (this credential, every model)
 *
 * A provider whose chain has a single credential never gets pair breakers: the caller
 * omits `keyHashPrefix` and every path degenerates to the bare-modelId breaker
 * — byte-identical to pre-P3 (the ADR's single-credential degeneracy guarantee).
 */
export class CircuitBreakerManager {
  private breakers = new Map<string, CircuitBreaker>();
  private pairs = new Map<string, PairRecord>();
  // modelId -> provider, so account-wide expansion and SUSPECT lookups can name the
  // account owner even for pair breakers created lazily on a failure path.
  private modelProviders = new Map<string, string>();
  private config: CircuitBreakerConfig;
  private nowFn: () => number;
  private accountState: AccountStateStore;

  constructor(
    config?: CircuitBreakerConfig,
    nowFn: () => number = Date.now,
    accountState?: AccountStateStore
  ) {
    this.config = config || {};
    this.nowFn = nowFn;
    this.accountState = accountState ?? defaultAccountStateStore();
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
        this.nowFn
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
      breaker = new CircuitBreaker(modelId, provider, tier, this.config, this.nowFn);
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
   * Trial-call budget per model per prober cycle (Decision 6 reuses
   * halfOpenMaxProbes, so pair fan-out cannot multiply background load).
   */
  public getProbeBudget(): number {
    return this.config.halfOpenMaxProbes ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxProbes;
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
          this.nowFn
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
   * ADR-0019 Decision 6 — CONSUMING gate at the finest attributed scope.
   * No `keyHashPrefix` (single-credential provider) is exactly `canExecute(modelId)`.
   * With a prefix the model breaker is only PEEKED and the pair breaker consumes
   * the canary slot. Consuming the model slot here would strand it: a pair-scope
   * verdict deliberately never reaches the model breaker, so a HALF_OPEN model
   * whose slot was spent on a request that came back 429-on-one-account would
   * sit with an exhausted quota while every account stayed healthy. Pair scope
   * therefore bounds background traffic by (accounts x halfOpenMaxProbes)
   * instead, and the model breaker closes on the first pair success
   * (see `recordSuccessScoped`).
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
   * ADR-0019 Decision 6 — the derived aggregate the pool builders will read:
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
   * ADR-0019 Decision 6 — the single NON-CONSUMING "out of service" predicate
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

  public recordSuccess(modelId: string): void {
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
   * ADR-0019 Decision 6 — success for one (model, credential). Without a
   * prefix this is today's `recordSuccess(modelId)`. With one, the pair breaker
   * closes and a HALF_OPEN model breaker is closed by the same verdict: the
   * scoped gate peeks the model breaker instead of consuming its slot, so a
   * recovering model needs an explicit closer and any credential that answers
   * proves the upstream is back.
   */
  public recordSuccessScoped(modelId: string, keyHashPrefix?: string, provider?: string): void {
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
    const breaker = this.getOrCreateBreaker(modelId, provider);
    breaker.recordFailure(diagnosis);
  }

  /**
   * ADR-0019 Decision 6 — record a failure and EXPAND it over the blast radius
   * the classifier diagnosed. Without a prefix (or without a `tripScope`, which
   * only ever exists under credential attribution) the diagnosis goes to the
   * bare-modelId breaker, exactly as before P3.
   *
   *   'pair'    -> this (model, credential) only
   *   'account' -> every model this credential can reach; SUSPECT if diagnosed
   *   'model'   -> the bare-modelId breaker (aggregation takes the model down)
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
    if (!keyHashPrefix) {
      this.recordFailure(modelId, diagnosis, provider ?? 'unknown');
      return;
    }

    const owner = this.resolveProvider(modelId, provider);
    const scope: TripScope = diagnosis.tripScope ?? 'model';
    if (scope === 'model') {
      this.recordFailure(modelId, diagnosis, owner);
      return;
    }

    if (scope === 'pair') {
      this.getOrCreatePair(modelId, keyHashPrefix, owner).breaker.recordFailure(diagnosis);
      return;
    }

    // account-wide: the credential is the problem, on every model it can serve.
    if (!this.modelProviders.has(modelId)) this.modelProviders.set(modelId, owner);
    const rowTargets = new Set(this.accountModelIds(owner, keyHashPrefix));
    rowTargets.add(modelId);
    for (const target of rowTargets) {
      this.getOrCreatePair(target, keyHashPrefix, owner).breaker.recordFailure(diagnosis);
    }
    // SUSPECT is administrative and auth-only: quota recovers by itself, a
    // dead key does not (Decision 6). Manual trips never set it.
    if (diagnosis.accountSuspect) {
      this.accountState.mark(owner, keyHashPrefix, diagnosis.reason);
    }
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
   * rotation from the console). In-memory only: cleared on gateway restart;
   * use the exclude lists (config.tiers) for a persistent exclusion.
   */
  public trip(modelId: string, options?: ManualTripOptions, provider = 'unknown'): TripResult {
    const breaker = this.getOrCreateBreaker(modelId, provider);
    const cooldownMs = this.manualCooldownMs(options);
    breaker.trip(`Manual trip: ${this.manualReason(options)}`, 'MANUAL', cooldownMs);
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
    const pair = this.getOrCreatePair(modelId, keyHashPrefix, provider);
    const cooldownMs = this.manualCooldownMs(options);
    pair.breaker.trip(`Manual trip: ${this.manualReason(options)}`, 'MANUAL', cooldownMs);
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
      this.getOrCreatePair(modelId, keyHashPrefix, providerId).breaker.trip(reason, 'MANUAL', cooldownMs);
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
   * Manual (console/REST) trip with ADR-0019 scope. `model` is the legacy
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
