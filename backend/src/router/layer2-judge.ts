import { ChatCompletionRequest } from '../types/openai.js';
import { EFFORT_LADDER, ReasoningEffort, TierLevel, ReasonParams } from '../types/router.js';
import { Layer2JudgeConfig } from '../config/types.js';
import { RoutingDecisionCache, type RoutingCacheStats } from './decision-cache.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { UpstreamEventContext } from '../providers/base.js';
import { runSystemoneDecision } from '../protocols/systemone/decide.js';
import { SystemoneRequest } from '../protocols/systemone/types.js';
import { captureDecision } from '../capture/decision-capture.js';
import { ErrorClassifier } from '../resilience/index.js';
import { recordFailureEvent } from '../observability/failure-events.js';
import { getWarnThrottle } from '../observability/warn-throttle.js';

export interface Layer2JudgeResult {
  targetTier: TierLevel;
  confidence: number;
  reason: string;
  reasonCode: string;
  reasonParams?: ReasonParams;
  provider: string;
  model: string;
  /**
   * Judge-decided thinking level (ADR-0012) — present only when the
   * `effort` question was asked (effortDecision on + client omitted the
   * field) AND the answer parsed. A missing/garbled effort answer never
   * sinks a good tier decision (partial success).
   */
  effort?: ReasoningEffort;
  effortConfidence?: number;
  rawResponse?: any;
}

const TIERS: TierLevel[] = ['lite', 'plus', 'pro', 'ultra'];

/**
 * Layer 2: Specialized Context-Aware Decision Judge Model.
 *
 * The judge speaks the gateway's OWN System One protocol —
 * there is no vendor SDK and no hand-rolled vendor wire here. One `choice`
 * question over the four-tier vocabulary; the same executor that serves
 * `POST /v1/systemone` serves this call, so a native decision model
 * (Jev / Bailian) passes through natively while ANY registered chat model
 * serves through protocol conversion.
 *
 * Converted probabilities are self-reported estimates, NOT calibrated —
 * the `reason` records which upstream class answered so
 * a consumer reading a trace can tell the two apart.
 */
/**
 * Outcome of the judge's last real wire attempt (ADR-0011 observability):
 * the /auto page surfaces a failure until a later attempt succeeds. Cache
 * hits are NOT attempts and never overwrite this record.
 */
export interface JudgeLastOutcome {
  ts: number;
  modelId: string;
  ok: boolean;
  /** Timeout / upstream error / unparseable payload — human-readable, short. */
  error?: string;
  latencyMs?: number;
}

export class Layer2Judge {
  private static readonly TIER_INSTRUCTIONS =
    'Classify the computational task difficulty tier. NEVER judge difficulty by character length: ' +
    'short prompts like "P=NP?" or "Prove Fermat\'s Last Theorem" are high-difficulty.';

  /**
   * Outcome of the LAST real wire attempt (console /auto surface). Cache
   * hits never touch it: a cached serve is not a wire attempt and must not
   * hide a persisting wire problem. In-memory only — a gateway restart
   * starts blank, and the first attempt after boot re-records it.
   */
  private static lastOutcome: JudgeLastOutcome | null = null;

  /** Console read accessor (GET /api/admin/judge/outcome). */
  public static getLastOutcome(): JudgeLastOutcome | null {
    return Layer2Judge.lastOutcome;
  }

  private static readonly TIER_CRITERIA: Record<TierLevel, string> = {
    lite: 'trivial QA, simple calculation, basic translation, shallow extraction, casual greetings',
    plus:
      'system architecture, complex software engineering, refactoring, creative generation, nuanced thinking — the default workhorse',
    pro: 'deep mathematical proof, formal symbolic logic, NP-hard algorithmic complexity, hard research',
    ultra: 'frontier-tier, hour-long autonomous agent tasks, hardest open-ended thinking',
  };

  private static readonly EFFORT_INSTRUCTIONS =
    'Pick the thinking depth this task actually needs. Deeper thinking costs more time and tokens — ' +
    'choose the LOWEST level that can produce a correct, complete answer.';

  private static readonly EFFORT_CRITERIA: Record<ReasoningEffort, string> = {
    none: 'no thinking needed — direct answer suffices (greeting, lookup, trivial rewrite)',
    low: 'light reasoning — simple Q&A, basic translation, shallow extraction',
    medium: 'moderate reasoning — typical coding, summarization with judgment calls',
    high: 'deep reasoning — system design, multi-step debugging, nuanced analysis',
    xhigh: 'very deep reasoning — hard algorithmic work, formal proofs, research-grade problems',
    max: 'maximum effort — frontier open-ended tasks where cost is no object',
  };

  /** Stable label for the decision-cache key namespace. */
  private static readonly CACHE_SOURCE = 'systemone';

  /**
   * Cache-namespace split on the effortDecision gate (ADR-0012 §3): entries
   * recorded with the effort question in play must never be served to a
   * caller running with it off (or vice versa) — the stored answer set
   * differs, so the namespace differs.
   */
  private static cacheSource(askEffort: boolean): string {
    return askEffort ? `${this.CACHE_SOURCE}+effort` : this.CACHE_SOURCE;
  }

  /** One-shot warnings: a misconfigured judge is a per-REQUEST condition, so
   *  a plain console.warn would flood the log once per uncached request. */
  private static warned = new Set<string>();

  private static warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  // routing decision cache (LRU+TTL over judge results)
  private static decisionCache: RoutingDecisionCache | null = null;

  private static getDecisionCache(config?: Layer2JudgeConfig): RoutingDecisionCache {
    // Singleton instance; the console's knob changes (enabled/ttl/maxEntries)
    // hot-apply through applyConfig on every evaluate — no restart needed.
    if (!this.decisionCache) {
      this.decisionCache = new RoutingDecisionCache(config?.decisionCache);
    } else {
      this.decisionCache.applyConfig(config?.decisionCache);
    }
    return this.decisionCache;
  }

  public static getDecisionCacheStats(): RoutingCacheStats {
    return (this.decisionCache || new RoutingDecisionCache({ enabled: false })).getStats();
  }

  public static clearDecisionCache(): void {
    this.decisionCache?.clear();
  }

  /** Build the System One request that asks for a difficulty tier. */
  private static buildRequest(state: string, modelId: string, askEffort: boolean): SystemoneRequest {
    const criteria: Record<string, string> = {};
    for (const tier of TIERS) criteria[tier] = this.TIER_CRITERIA[tier];
    const questions: SystemoneRequest['questions'] = {
      tier: {
        type: 'choice',
        instructions: this.TIER_INSTRUCTIONS,
        criteria,
      },
    };
    if (askEffort) {
      // ADR-0012 §1: the SAME call also judges the thinking depth — a
      // choice over the full 6-level ladder, 'none' included (a legitimate
      // "do not think" judgment). Asked only for client-omitted requests.
      questions!.effort = {
        type: 'choice',
        instructions: this.EFFORT_INSTRUCTIONS,
        criteria: { ...this.EFFORT_CRITERIA },
      };
    }
    return {
      model: modelId,
      state,
      questions,
    };
  }

  private static toTier(answer: any): TierLevel | null {
    const choice = typeof answer?.choice === 'string' ? answer.choice.trim().toLowerCase() : '';
    return (TIERS as string[]).includes(choice) ? (choice as TierLevel) : null;
  }

  /**
   * Tolerant effort-answer parse: anything outside the 6-level ladder
   * (garbled choice, missing answer object) yields undefined — never an
   * error. A bad effort answer must not sink a good tier decision.
   */
  private static toEffort(answer: any): { effort: ReasoningEffort; confidence: number } | undefined {
    const choice = typeof answer?.choice === 'string' ? answer.choice.trim().toLowerCase() : '';
    if (!(EFFORT_LADDER as readonly string[]).includes(choice)) return undefined;
    const raw = answer?.confidence;
    const confidence = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(1, Math.max(0, raw))
      : 0.9;
    return { effort: choice as ReasoningEffort, confidence };
  }

  /**
   * Evaluate request using the Layer 2 decision model over the System One
   * protocol. Returns null on any miss — a disabled judge, an unresolvable
   * model, an upstream failure or a blown deadline all degrade gracefully to
   * the caller's default (plus baseline) rather than throwing.
   *
   * `judgeCapture` is the OUTER request's capture identity (the orchestrator
   * hands it through routeAsync when the capture master is on; undefined
   * otherwise). The JUDGE-CALL gate is checked HERE, at judge entry, via the
   * recorder accessor — three-tier master/sub chain (requestCapture.enabled
   * master × systemone.enabled surface master × systemone.l2DecisionEnabled
   * sub):
   * a false verdict passes undefined down the whole chain — today's silence,
   * zero behavior change when the flags are off.
   */
  public static async evaluate(
    request: ChatCompletionRequest,
    config: Layer2JudgeConfig | undefined,
    registry: ProviderRegistry,
    defaultModel?: string,
    judgeCapture?: UpstreamEventContext,
    /** Owning turn's conversation session — threaded by the orchestrator so
     *  judge failures attribute to the conversation that suffered them. */
    sessionId?: string
  ): Promise<Layer2JudgeResult | null> {
    if (!config?.enabled) return null;

    const requested = (config.model || '').trim();
    const modelId =
      requested && requested !== 'auto' ? requested : (defaultModel || '').trim();
    // An enabled judge that names nothing can never answer. Say so ONCE
    // instead of degrading silently forever — this is exactly the upgrade
    // path where a legacy `model: 'typesafe/jev'` (never a registered id)
    // leaves Layer 2 permanently inert with no trace anywhere.
    if (!modelId) {
      this.warnOnce(
        'unconfigured',
        '[Layer2Judge] enabled but no decision model resolves (classifier.layer2.model and ' +
          'systemone.defaultModel are both unset) — every judgment falls back to the plus baseline.'
      );
      return null;
    }

    const model = registry.getModel(modelId);
    if (!model) {
      this.warnOnce(
        `missing:${modelId}`,
        `[Layer2Judge] decision model '${modelId}' is not a registered model — every judgment ` +
          'falls back to the plus baseline. Register it, or point classifier.layer2.model at ' +
          'systemone.defaultModel.'
      );
      return null;
    }

    // ADR-0012: the effort question rides the same call only when the gate
    // is on AND the client omitted `reasoning_effort` (an explicit client
    // value is never second-guessed — asking would be a wasted answer).
    const askEffort = config.effortDecision === true && request.reasoning_effort === undefined;

    // Extract recent conversational context for multi-turn awareness (last 4 turns)
    const messages = request.messages || [];
    const recentMessages = messages.length > 4 ? messages.slice(-4) : messages;
    const userText = recentMessages
      .map((m) => {
        const role = m.role || 'user';
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p) => p.text || '').join(' ')
            : '';
        return `${role}: ${content}`;
      })
      .join('\n');
    // The cache key must describe EXACTLY what the model will see, otherwise two
    // requests that differ only past the cut-off collide in the model but not
    // in the cache (pointless upstream calls).
    const state = userText.slice(0, 4000);

    // reuse a prior identical-context decision before calling out
    const decisionCache = this.getDecisionCache(config);
    const cacheKey = RoutingDecisionCache.buildCacheKey(this.cacheSource(askEffort), model.id, state);
    const cached = decisionCache.get(cacheKey);
    if (cached) {
      // Propagate the cached decision's code+params untouched; the cache hit
      // itself is only a flag in params (no separate cache-hit code). Copy the
      // params — never mutate the stored entry.
      return {
        targetTier: cached.targetTier as TierLevel,
        confidence: cached.confidence,
        reason: `[Decision Cache] ${cached.reason}`,
        reasonCode: cached.reasonCode,
        reasonParams: { ...cached.reasonParams, cached: true },
        provider: model.provider,
        model: model.id,
        effort: cached.effort as ReasoningEffort | undefined,
        effortConfidence: cached.effortConfidence,
      };
    }

    const timeoutMs = config.timeoutMs || 5000;
    const startedAt = Date.now();
    // The judge's own deadline wins over the upstream's: System One is a fast
    // decision surface, and a stale answer is worthless to a routing cascade.
    // Aborting at the deadline stops the work for real where the transport
    // allows it (native upstream) and at minimum suppresses the follow-up
    // repair call we would otherwise fire AFTER we stopped waiting.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An abandoned late result (the converted path cannot be cancelled
    // mid-flight) must never reach the capture sink — the deadline flag is
    // the only reliable "this answer was consumed" signal.
    let timedOut = false;
    // Wire-attempt failure reason (console /auto surface): cache hits never
    // reach this path and never overwrite the record — a cached serve does
    // not heal the underlying wire problem, so the warning must stay.
    let failureReason: string | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    // JUDGE-CALL CAPTURE gate (three-tier chain: requestCapture.enabled
    // master × systemone.enabled surface master × systemone.l2DecisionEnabled
    // sub — checked HERE via the recorder carried by the outer
    // identity; master off means the orchestrator never even passes a ctx).
    // ON: reuse the OUTER request's trace/session so the judge's wire call
    // joins the routed turn's archive, labeled purpose 'l2-judge' to tell it
    // from candidate-execution events. OFF: undefined = silence, the exact
    // call shape as today.
    const judgeCaptureCtx: UpstreamEventContext | undefined =
      judgeCapture && judgeCapture.recorder.isSystemoneJudgeCaptureEnabled()
        ? { ...judgeCapture, purpose: 'l2-judge' }
        : undefined;
    const pending = runSystemoneDecision(
      registry,
      this.buildRequest(state, model.id, askEffort),
      model,
      { signal: controller.signal, upstreamEventContext: judgeCaptureCtx }
    )
      .then((decision) => {
        const answer = (decision.response as any)?.answers?.tier;
        const tier = this.toTier(answer);
        if (!tier) {
          failureReason = 'unparseable decision payload';
          return null;
        }
        // Partial success (ADR-0012 §1): the effort answer parses
        // tolerantly — a garbled/missing one never sinks a good tier.
        const effortAnswer = askEffort
          ? this.toEffort((decision.response as any)?.answers?.effort)
          : undefined;
        // A native upstream's confidence is taken at face value, so a NaN or
        // out-of-range value would flow verbatim into RoutingDecision (where
        // JSON.stringify(NaN) silently becomes null on any serialized sink).
        // The converted path is already clamped by convert.ts.
        const raw = answer?.confidence;
        const confidence = typeof raw === 'number' && Number.isFinite(raw)
          ? Math.min(1, Math.max(0, raw))
          : 0.9;
        const reason =
          decision.upstreamKind === 'native'
            ? `System One model ${model.id} classified this as ${tier}`
            : `System One model ${model.id} classified this as ${tier} (self-reported, not yet calibrated)`;
        const reasonCode =
          decision.upstreamKind === 'native' ? 'l2.system_one' : 'l2.system_one_uncalibrated';
        // Opt-in dataset sink (classifier.layer2.collectEnabled, gated inside
        // decision-capture): the judged pair is the raw material for distilling
        // a native decision model. Recorded ONLY on the race-winner path — an
        // abandoned late result must not pollute the dataset with an answer
        // nobody consumed.
        if (!timedOut) {
          captureDecision({
            model: model.id,
            provider: model.provider,
            upstreamKind: decision.upstreamKind,
            state,
            tier,
            confidence,
            latencyMs: Date.now() - startedAt,
          });
        }
        return {
          targetTier: tier,
          confidence,
          reason,
          reasonCode,
          reasonParams: { model: model.id, tier, ...(effortAnswer ? { effort: effortAnswer.effort } : {}) },
          provider: model.provider,
          model: model.id,
          effort: effortAnswer?.effort,
          effortConfidence: effortAnswer?.confidence,
          rawResponse: decision.response,
        } satisfies Layer2JudgeResult;
      })
      .catch((err: unknown) => {
        failureReason = err instanceof Error ? err.message : String(err);
        // Failure-ledger emission (judge role): the wire call itself failed.
        // A rejection landing after the deadline already fired the race is
        // skipped — the timeout branch owns that observation; recording both
        // would double-count one abandoned call.
        if (!timedOut) {
          const diagnosis = ErrorClassifier.classify(err, model.id, model.provider);
          recordFailureEvent({
            model: model.id,
            provider: model.provider,
            errorClass: diagnosis.category,
            status: diagnosis.statusCode,
            message: failureReason,
            role: 'judge',
            sessionId,
          });
        }
        return null;
      });

    try {
      const outcome = await Promise.race([pending, deadline]);
      if (!outcome) {
        const error = timedOut ? `timeout after ${timeoutMs}ms` : failureReason || 'decision failed';
        // Console-visible last-wire-attempt record (ADR-0011 observability):
        // the /auto page shows the failure until a later attempt succeeds.
        Layer2Judge.lastOutcome = {
          ts: Date.now(),
          modelId: model.id,
          ok: false,
          error,
        };
        // Failure-ledger emission for the deadline case: an abandoned wire
        // request has no error object to classify, so it records as TIMEOUT
        // (the catch handler skips its own row when this branch already
        // fired — one abandoned call, one row).
        if (timedOut) {
          recordFailureEvent({
            model: model.id,
            provider: model.provider,
            errorClass: 'TIMEOUT',
            message: error,
            role: 'judge',
            sessionId,
          });
        }
        // Throttled warn over the formerly silent failure modes: a dead
        // judge used to produce nothing but a missing tier decision. One
        // throttled line per failing model keeps the log honest without a
        // QPS flood; the /auto last-outcome record above still carries the
        // always-fresh single verdict.
        getWarnThrottle().warn(
          `judge-wire:${model.id}`,
          `[ocr] judge wire call failed on ${model.id}: ${error}`
        );
        return null;
      }
      Layer2Judge.lastOutcome = {
        ts: Date.now(),
        modelId: model.id,
        ok: true,
        latencyMs: Date.now() - startedAt,
      };
      decisionCache.set(cacheKey, {
        targetTier: outcome.targetTier,
        confidence: outcome.confidence,
        reason: outcome.reason,
        reasonCode: outcome.reasonCode,
        reasonParams: outcome.reasonParams,
        effort: outcome.effort,
        effortConfidence: outcome.effortConfidence,
      });
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}