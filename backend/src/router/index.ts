import type { CanonicalRequest, RouterOptions } from '../ir/types.js';
import type { RoutingDecision, TierLevel } from '../types/router.js';
import { Layer2Decision } from './layer2-decision.js';
import { declaresJsonContract } from './request-traits.js';
import type { ClassifierConfig, RoutingMode } from '../config/types.js';
import { tierFromVirtualEntry } from '../auth/model-access.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { UpstreamEventContext } from '../providers/base.js';

export function routingModeForceTier(
  model: string | undefined,
  routerOptions: RouterOptions | undefined,
  mode: RoutingMode | undefined,
): TierLevel | undefined {
  if (!mode || mode === 'smart' || routerOptions?.forceTier) return undefined;
  if (model && model !== 'auto' && tierFromVirtualEntry(model) === '') return undefined;
  return mode === 'cost' ? 'lite' : 'pro';
}

export class RouterEngine {
  public static async routeAsync(
    request: CanonicalRequest,
    classifierConfig?: ClassifierConfig,
    registry?: ProviderRegistry,
    systemoneDefaultModel?: string,
    decisionCapture?: UpstreamEventContext,
    sessionId?: string,
  ): Promise<RoutingDecision> {
    const needsSchemaValidation = declaresJsonContract(request);
    if (request.routerOptions?.forceTier) {
      const forced = request.routerOptions.forceTier;
      return {
        targetTier: forced, confidence: 1, reason: `Pinned to ${forced} by request settings`,
        reasonCode: 'forced', reasonParams: { tier: forced }, layerUsed: 'layer0', needsSchemaValidation,
      };
    }
    if (classifierConfig?.layer2?.enabled && registry) {
      const result = await Layer2Decision.evaluate(
        request, classifierConfig.layer2, registry, systemoneDefaultModel, decisionCapture, sessionId,
      );
      if (result) {
        return {
          targetTier: result.targetTier, confidence: result.confidence, layerUsed: 'layer2',
          reason: result.reason, reasonCode: result.reasonCode, reasonParams: result.reasonParams,
          needsSchemaValidation, effort: result.effort, effortConfidence: result.effortConfidence,
        };
      }
    }
    return {
      targetTier: 'plus', confidence: 1, layerUsed: 'layer0',
      reason: 'No decision layer decision available — defaulting to the plus quality baseline',
      reasonCode: 'default', needsSchemaValidation,
    };
  }
}
