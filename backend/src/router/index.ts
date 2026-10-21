import { ChatCompletionRequest } from '../types/openai.js';
import { RoutingDecision, TierLevel } from '../types/router.js';
import { Layer2Judge } from './layer2-judge.js';
import { hasToolsOrSchema } from './request-traits.js';
import { ClassifierConfig, RoutingMode } from '../config/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { UpstreamEventContext } from '../providers/base.js';

/**
 * Global routing mode → forced tier for auto/default requests. Returns undefined
 * when the mode is 'smart' (normal cascade), when the client already forced a
 * tier, or when a concrete model was requested — explicit choice always wins.
 */
export function routingModeForceTier(
  model: string | undefined,
  routerOptions: { force_tier?: TierLevel } | undefined,
  mode: RoutingMode | undefined
): TierLevel | undefined {
  if (!mode || mode === 'smart') return undefined;
  if (routerOptions?.force_tier) return undefined;
  if (model && model !== 'auto' && model !== 'default') return undefined;
  return mode === 'cost' ? 'lite' : 'pro';
}

export class RouterEngine {
  /**
   * Asynchronous Hierarchical Routing
   * Layer 0 (explicit request rules) -> Layer 2 (System One decision model) -> Safe Quality Baseline (plus tier)
   *
   * `registry` + `systemoneDefaultModel` are the Layer 2 judge's dependencies:
   * it resolves and calls a registered model over the gateway's own System One
   * protocol, so it needs the model pool and the default decision
   * model that backs an unset `classifier.layer2.model`.
   *
   * `judgeCapture` is the outer request's capture identity, threaded to the
   * judge so its decision-model HTTP leg can be recorded on the SAME
   * trace/session (the judge gates it; callers just hand over the identity).
   */
  public static async routeAsync(
    request: ChatCompletionRequest,
    classifierConfig?: ClassifierConfig,
    registry?: ProviderRegistry,
    systemoneDefaultModel?: string,
    judgeCapture?: UpstreamEventContext
  ): Promise<RoutingDecision> {
    // Structured-output requests arm the orchestrator's lite-first
    // schema-assertion cascade regardless of the decided tier.
    const needsSchemaValidation = hasToolsOrSchema(request);

    // 1. Force Tier Override (for testing or explicit client choice)
    if (request.router_options?.force_tier) {
      const forced = request.router_options.force_tier;
      return {
        targetTier: forced,
        confidence: 1.0,
        reason: `Pinned to ${forced} by request settings`,
        reasonCode: 'forced',
        reasonParams: { tier: forced },
        layerUsed: 'layer0',
        needsSchemaValidation,
      };
    }

    // 2. Layer 2: Specialized Semantic Decision Judge over the System One protocol
    if (classifierConfig?.layer2?.enabled && registry) {
      const decisionResult = await Layer2Judge.evaluate(
        request,
        classifierConfig.layer2,
        registry,
        systemoneDefaultModel,
        judgeCapture
      );
      if (decisionResult) {
        return {
          targetTier: decisionResult.targetTier,
          confidence: decisionResult.confidence,
          layerUsed: 'layer2',
          reason: decisionResult.reason,
          reasonCode: decisionResult.reasonCode,
          reasonParams: decisionResult.reasonParams,
          needsSchemaValidation,
          // ADR-0012: the judge's effort answer (present only when the
          // client omitted the field) — the orchestrator injects it.
          effort: decisionResult.effort,
          effortConfidence: decisionResult.effortConfidence,
        };
      }
    }

    // 3. Default Quality-First Decision (Safe Flagship Baseline): when no
    // judge produced a decision, route to the plus tier — never degrade to
    // lite on a guess.
    return {
      targetTier: 'plus',
      confidence: 1.0,
      layerUsed: 'layer0',
      reason: 'No judge decision available — defaulting to the plus quality baseline',
      reasonCode: 'default',
      needsSchemaValidation,
    };
  }
}
