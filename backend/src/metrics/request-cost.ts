import type { Usage } from '../ir/types.js';
import type { ModelPricing } from '../types/router.js';

/**
 * Request-time historical cost from the canonical accounting plane.
 *
 * Returns `undefined` when the model carries no known price. That is NOT the
 * same as 0: 0 means "served for free", while `undefined` means the vendor
 * publishes no dollar price (qoder publishes only a `price_factor` credit
 * multiplier). Collapsing the two is what made every unpriced model show a
 * confident but invented cost, so callers must keep the distinction and let
 * an unknown sum out as unknown.
 */
export function computeRequestCost(usage: Usage | undefined, pricing: ModelPricing | undefined): number | undefined {
  if (!usage || !pricing) return undefined;
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cachedTokens);
  const outputTokens = usage.outputTokens;
  const reasoningTokens = usage.reasoningTokens ?? 0;
  const inputCost = (uncachedInput / 1_000_000) * pricing.input;
  const cachedCost = (cachedTokens / 1_000_000) * pricing.cacheRead;
  const outputCost = pricing.reasoning && reasoningTokens > 0
    ? (Math.max(0, outputTokens - reasoningTokens) / 1_000_000) * pricing.output
      + (Math.min(outputTokens, reasoningTokens) / 1_000_000) * pricing.reasoning
    : (outputTokens / 1_000_000) * pricing.output;
  return inputCost + cachedCost + outputCost;
}
