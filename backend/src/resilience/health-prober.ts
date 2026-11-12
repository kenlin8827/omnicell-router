import { CircuitBreakerManager } from './circuit-breaker-manager.js';
import { ErrorClassifier } from './error-classifier.js';
import { ModelRegistration } from '../config/types.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from '../config/defaults.js';
import { ChatCompletionRequest } from '../types/openai.js';
import { recordFailureEvent } from '../observability/failure-events.js';
import { clampProbeIntervalMs } from '../utils/probe-interval.js';
import type { CircuitBreakerSnapshot } from './types.js';

/** One selectable credential of a provider chain (the registry's key material stays out). */
export interface ProberCredential {
  keyHashPrefix: string;
}

export interface ProberTargetResolver {
  getModel(modelId: string): ModelRegistration | undefined;
  execute(
    request: ChatCompletionRequest,
    model: ModelRegistration,
    upstreamEventContext?: unknown,
    credentialKeyHashPrefix?: string
  ): Promise<any>;
  /**
   * The provider's credential chain in selection order.
   * Absent (stub resolver) or empty (chain-less provider) => the prober probes
   * the model with the boot-baked key, exactly as before P3.
   */
  getCredentialChain?(name: string): readonly ProberCredential[] | undefined;
}

/** One model's probe plan for a cycle: prefixes to try, in order. */
export interface ProbePlan {
  modelId: string;
  prefixes: (string | undefined)[];
}

/**
 * Active liveness sweep over tripped breakers, scope-aware:
 *
 *   model-scope trip       -> every tuple of the model is due; probe through
 *                             ONE representative credential within the budget
 *   tuple breaker down     -> probe the tuples that are due, within the per-model budget
 *
 * The budget is the HALF_OPEN trial budget (`rules.recovery.halfOpen.maxProbes`,
 * defaulting to `circuitBreaker.halfOpenMaxProbes`), so one model never
 * issues more than that many trial calls per cycle however many of its
 * credentials are tripped. Selection inside a model is deliberately dumb — first
 * chain entry that is neither OPEN nor SUSPECT. The prober validates; routing
 * decisions belong to the selection layer.
 */
export class ActiveHealthProber {
  private manager: CircuitBreakerManager;
  private resolver: ProberTargetResolver;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private isProbing = false;

  constructor(
    manager: CircuitBreakerManager,
    resolver: ProberTargetResolver,
    intervalMs?: number
  ) {
    this.manager = manager;
    this.resolver = resolver;
    this.intervalMs = clampProbeIntervalMs(intervalMs);
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.probeTrippedModels().catch(() => {
        // Silently swallow errors during background probe
      });
    }, this.intervalMs);
    // Never hold the process open for the sweep (QuotaProber precedent).
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** The CLAMPED sweep interval (constructor clamps to [10 s, 1 h]) — the boot
   *  log prints this, never the raw config value. */
  public getIntervalMs(): number {
    return this.intervalMs;
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Trial-eligible: HALF_OPEN already, or OPEN whose cooldown has elapsed. */
  private static isDue(s: CircuitBreakerSnapshot): boolean {
    return s.state === 'HALF_OPEN' || (s.state === 'OPEN' && s.remainingCooldownMs <= 0);
  }

  /**
   * Decide this cycle's calls WITHOUT executing them — separated so the budget
   * and the representative pick are directly assertable. Returns one entry per
   * model with something to validate; `prefixes` is capped by the budget.
   */
  public planProbes(): ProbePlan[] {
    const byModel = new Map<string, { model?: CircuitBreakerSnapshot; pairs: CircuitBreakerSnapshot[] }>();
    for (const s of this.manager.snapshotsWithPairs()) {
      const entry = byModel.get(s.modelId) ?? { pairs: [] as CircuitBreakerSnapshot[] };
      if (s.keyHashPrefix) entry.pairs.push(s);
      else entry.model = s;
      byModel.set(s.modelId, entry);
    }

    const plan: ProbePlan[] = [];
    for (const [modelId, group] of byModel) {
      const model = this.resolver.getModel(modelId);
      if (!model) continue;

      const chain = (this.resolver.getCredentialChain?.(model.provider) ?? []).map((c) => c.keyHashPrefix);
      // Pair mode = a chain is registered AND this model has per-credential state
      // (or more than one credential to choose from). No chain => single-credential
      // degeneracy => the bare model probe today's prober performs; that also
      // keeps a stale pair (chain removed after a disconnect) from starving the
      // model probe, since the representative pick needs a live chain entry.
      const multiCredentialMode = chain.length > 1 || (chain.length > 0 && group.pairs.length > 0);
      let budget = this.manager.getProbeBudget();
      const prefixes: (string | undefined)[] = [];

      if (budget > 0 && group.model && ActiveHealthProber.isDue(group.model)) {
        if (!multiCredentialMode) {
          prefixes.push(undefined);
          budget--;
        } else {
          const representative = chain.find((prefix) => !this.manager.isPairOut(modelId, prefix));
          // A model-scope trip whose every credential is out has no representative
          // to try this cycle — the pair breakers still report their own cooldowns,
          // so do NOT skip this model: its due tuples below are probed as usual.
          if (representative !== undefined) {
            prefixes.push(representative);
            budget--;
          }
        }
      }

      for (const pair of group.pairs) {
        if (budget <= 0) break;
        if (!pair.keyHashPrefix || !ActiveHealthProber.isDue(pair)) continue;
        // Never auto-return a SUSPECT credential: it must be reconnected, not probed.
        if (this.manager.isSuspect(modelId, pair.keyHashPrefix)) continue;
        // Same verdict for an operator DISABLED credential: a takedown never
        // auto-returns (isPairOut already treats it as out), so probing it has
        // zero recovery value — it would only burn maxProbes budget, and a
        // model-scope probe failure re-trips its healthy sibling tuples.
        if (this.manager.isDisabled(modelId, pair.keyHashPrefix)) continue;
        if (prefixes.includes(pair.keyHashPrefix)) continue;
        prefixes.push(pair.keyHashPrefix);
        budget--;
      }

      if (prefixes.length > 0) plan.push({ modelId, prefixes });
    }
    return plan;
  }

  public async probeTrippedModels(): Promise<void> {
    if (this.isProbing) return;
    this.isProbing = true;

    try {
      for (const probe of this.planProbes()) {
        const model = this.resolver.getModel(probe.modelId);
        if (!model) continue;
        for (const prefix of probe.prefixes) {
          // Consuming admission: drives OPEN→HALF_OPEN once the cooldown
          // elapses, takes the trial slot, and skips when a real canary
          // already holds it — synthetic and real trials never race. The
          // outcome is recorded against the returned prefix, which may differ
          // from the probe target (representative pick for a model-scope
          // trip: the trial belongs to the armed tuple).
          const trial = this.manager.acquireProbeTrial(probe.modelId, prefix);
          if (!trial) continue;
          await this.probeOne(model, prefix, trial.recordPrefix);
        }
      }
    } finally {
      this.isProbing = false;
    }
  }

  /**
   * One trial call. `credentialKeyHashPrefix` undefined = the boot-baked key.
   * Outcomes go through the scoped API, so a pair/credential verdict cannot cool
   * the model for its healthy siblings; `registry.execute` re-stamps the used
   * credential onto the error, which is what gives the diagnosis its scope.
   */
  private async probeOne(
    model: ModelRegistration,
    credentialKeyHashPrefix: string | undefined,
    recordPrefix: string | undefined
  ): Promise<void> {
    const probeRequest: ChatCompletionRequest = {
      model: model.upstreamModel,
      messages: [{ role: 'user', content: 'health_check_ping' }],
      max_tokens: 1,
    };

    try {
      // The call always goes through the probe-target credential; only the
      // OUTCOME routing differs (see acquireProbeTrial).
      await withTimeout(
        this.resolver.execute(probeRequest, model, undefined, credentialKeyHashPrefix),
        DEFAULT_PROBE_TIMEOUT_MS
      );
      // If successful, record success and close the breaker(s)!
      this.manager.recordSuccessScoped(model.id, recordPrefix, model.provider);
    } catch (err: any) {
      const diagnosis = ErrorClassifier.classify(err, model.id, model.provider);
      // Physical attribution: the stamp inside `diagnosis` names the credential
      // that actually served the ping, so the credential blast radius, the
      // SUSPECT mark and the quota ledger row all land on the culprit — never
      // on the armed tuple, which was not probed. The armed tuple then takes a
      // pair-scoped verdict of its own when that radius never reached it.
      this.manager.recordProbeFailure(
        model.id,
        diagnosis,
        model.provider,
        recordPrefix,
        credentialKeyHashPrefix
      );
      // Ledger attribution: probe rows carry role 'probe' so console views can
      // separate synthetic trials from serving traffic (the failure-events
      // ring coalesces repeats either way).
      recordFailureEvent({
        model: model.id,
        provider: model.provider,
        // The probe ran through `credentialKeyHashPrefix`; the diagnosis stamp
        // names the credential that actually answered when the execution path
        // re-stamped it (registry invariant for chain-less providers absent).
        keyHashPrefix: diagnosis.usedKeyHashPrefix ?? credentialKeyHashPrefix,
        errorClass: diagnosis.category,
        status: diagnosis.statusCode,
        message: err?.message ?? String(err),
        role: 'probe',
      });
    }
  }
}

/**
 * Race one probe call against a wall clock — resolver.execute has no
 * AbortSignal contract, so an overstaying ping is abandoned here. A timeout
 * counts as outage evidence (the tuple's accounting already moved on), the
 * late-settling outcome is simply dropped, and the late rejection is
 * swallowed so the settled race never surfaces an unhandled rejection.
 * Abandoning the WAIT does not cancel the exchange: a hung provider keeps one
 * orphaned call alive per cycle until its own provider timeout
 * (DEFAULT_PROVIDER_TIMEOUT_MS, 300 s) expires, holding that credential's
 * concurrency and quota for the window. The next sweep cycle re-probes;
 * trials are idempotent.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // No-op catch on the loser: once the race settles, the late branch must not
  // surface as an unhandled rejection.
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`health probe timed out after ${timeoutMs}ms`)), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    // Fast path: don't leave a dormant 30 s handle behind per probe.
    if (timer) clearTimeout(timer);
  }
}
