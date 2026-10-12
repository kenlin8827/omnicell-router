import { ChatCompletionRequest } from '../types/openai.js';
import { RoutingDecision, TierLevel } from '../types/router.js';
import { Layer1Classifier } from './layer1-classifier.js';
import { Layer2Judge } from './layer2-judge.js';
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
   * Pure model-driven & semantic intent routing.
   * Completely rejects naive character-count or language-specific string heuristics.
   */
  public static route(
    request: ChatCompletionRequest,
    classifierConfig?: ClassifierConfig
  ): RoutingDecision {
    const messages = request.messages || [];
    const extracted = Layer1Classifier.extractFeatures(request);
    const metrics = extracted.metrics;
    const needsSchemaValidation = metrics.hasToolsOrSchema;

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
        features: {
          tokenCountEstimate: metrics.tokenCount,
          hasCode: metrics.hasCode,
          hasMathOrProof: metrics.symbolEntropy > 0.7,
          hasMultiTurn: metrics.turnCount > 3,
          hasToolsOrSchema: needsSchemaValidation,
          complexityScore: 5.0,
        },
      };
    }

    // 2. Layer 1: CPU Micro-Tensor Classifier (Base Scaffold or Trained Micro-Model)
    const prediction = Layer1Classifier.predict(request, classifierConfig?.localModel);
    return {
      targetTier: prediction.targetTier,
      confidence: prediction.confidence,
      layerUsed: 'layer1',
      reason: prediction.reason,
      reasonCode: prediction.reasonCode,
      reasonParams: prediction.reasonParams,
      needsSchemaValidation: prediction.needsSchemaValidation,
      features: {
        tokenCountEstimate: metrics.tokenCount,
        hasCode: metrics.hasCode,
        hasMathOrProof: metrics.symbolEntropy > 0.7,
        hasMultiTurn: metrics.turnCount > 3,
        hasToolsOrSchema: needsSchemaValidation,
        complexityScore: prediction.targetTier === 'ultra' ? 9.0 : prediction.targetTier === 'pro' ? 7.0 : prediction.targetTier === 'plus' ? 4.0 : 1.0,
      },
    };
  }

  /**
   * Asynchronous Hierarchical Routing
   * Layer 1 (Local Model Base / Experience) -> Layer 2 (System One decision model) -> Safe Quality Baseline (plus tier)
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
    const messages = request.messages || [];
    const extracted = Layer1Classifier.extractFeatures(request);
    const metrics = extracted.metrics;
    const needsSchemaValidation = metrics.hasToolsOrSchema;

    // 1. Force Tier Override
    if (request.router_options?.force_tier) {
      return this.route(request, classifierConfig);
    }

    // 2. Layer 1: CPU Classifier (with confidence gating)
    // When using untrained base model, confidence is ~0.33 < 0.85, so isConfident is false,
    // guaranteed to cascade to Layer 2 without short-circuiting!
    const prediction = Layer1Classifier.predict(request, classifierConfig?.localModel);
    if (classifierConfig?.localModel?.enabled && prediction.isConfident) {
      return {
        targetTier: prediction.targetTier,
        confidence: prediction.confidence,
        layerUsed: 'layer1',
        reason: prediction.reason,
        reasonCode: prediction.reasonCode,
        reasonParams: prediction.reasonParams,
        needsSchemaValidation: prediction.needsSchemaValidation,
        features: {
          tokenCountEstimate: metrics.tokenCount,
          hasCode: metrics.hasCode,
          hasMathOrProof: metrics.symbolEntropy > 0.7,
          hasMultiTurn: metrics.turnCount > 3,
          hasToolsOrSchema: needsSchemaValidation,
          complexityScore: prediction.targetTier === 'ultra' ? 9.0 : prediction.targetTier === 'pro' ? 7.0 : prediction.targetTier === 'plus' ? 4.0 : 1.0,
        },
      };
    }

    // 4. Layer 2: Specialized Semantic Decision Judge over the System One protocol
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
          features: {
            tokenCountEstimate: metrics.tokenCount,
            hasCode: metrics.hasCode,
            hasMathOrProof: metrics.symbolEntropy > 0.7,
            hasMultiTurn: metrics.turnCount > 3,
            hasToolsOrSchema: needsSchemaValidation,
            complexityScore: decisionResult.targetTier === 'ultra' ? 9.0 : decisionResult.targetTier === 'pro' ? 7.0 : decisionResult.targetTier === 'plus' ? 4.0 : 1.0,
          },
        };
      }
    }

    // 5. Default Quality-First Decision (Safe Flagship Baseline)
    return {
      targetTier: prediction.targetTier,
      confidence: prediction.confidence,
      layerUsed: 'layer1',
      reason: prediction.reason,
      reasonCode: prediction.reasonCode,
      reasonParams: prediction.reasonParams,
      needsSchemaValidation: prediction.needsSchemaValidation,
      features: {
        tokenCountEstimate: metrics.tokenCount,
        hasCode: metrics.hasCode,
        hasMathOrProof: metrics.symbolEntropy > 0.7,
        hasMultiTurn: metrics.turnCount > 3,
        hasToolsOrSchema: needsSchemaValidation,
        complexityScore: prediction.targetTier === 'ultra' ? 9.0 : prediction.targetTier === 'pro' ? 7.0 : prediction.targetTier === 'plus' ? 4.0 : 1.0,
      },
    };
  }
}
