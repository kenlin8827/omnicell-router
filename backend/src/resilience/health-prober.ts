import { CircuitBreakerManager } from './circuit-breaker-manager.js';
import { ErrorClassifier } from './error-classifier.js';
import { ModelRegistration } from '../config/types.js';
import { ChatCompletionRequest } from '../types/openai.js';
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
    intervalMs = 60000
  ) {
    this.manager = manager;
    this.resolver = resolver;
    this.intervalMs = intervalMs;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.probeTrippedModels().catch(() => {
        // Silently swallow errors during background probe
      });
    }, this.intervalMs);
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

      if (group.model && ActiveHealthProber.isDue(group.model)) {
        if (!multiCredentialMode) {
          prefixes.push(undefined);
          budget--;
        } else {
          const representative = chain.find((prefix) => !this.manager.isPairOut(modelId, prefix));
          // A model-scope trip whose every credential is out has nothing to try this
          // cycle — the pair breakers report their own cooldowns.
          if (representative === undefined) continue;
          prefixes.push(representative);
          budget--;
        }
      }

      for (const pair of group.pairs) {
        if (budget <= 0) break;
        if (!pair.keyHashPrefix || !ActiveHealthProber.isDue(pair)) continue;
        // Never auto-return a SUSPECT credential: it must be reconnected, not probed.
        if (this.manager.isSuspect(modelId, pair.keyHashPrefix)) continue;
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
          await this.probeOne(model, prefix);
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
  private async probeOne(model: ModelRegistration, credentialKeyHashPrefix?: string): Promise<void> {
    const probeRequest: ChatCompletionRequest = {
      model: model.upstreamModel,
      messages: [{ role: 'user', content: 'health_check_ping' }],
      max_tokens: 1,
    };

    try {
      await this.resolver.execute(probeRequest, model, undefined, credentialKeyHashPrefix);
      // If successful, record success and close the breaker(s)!
      this.manager.recordSuccessScoped(model.id, credentialKeyHashPrefix, model.provider);
    } catch (err: any) {
      const diagnosis = ErrorClassifier.classify(err, model.id, model.provider);
      this.manager.recordFailureScoped(model.id, diagnosis, model.provider, credentialKeyHashPrefix);
    }
  }
}
