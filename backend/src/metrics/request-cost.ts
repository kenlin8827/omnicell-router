import type { Usage } from '../ir/types.js';
import type { ModelPricing } from '../types/router.js';

/** Request-time historical cost from the canonical accounting plane. */
export function computeRequestCost(usage: Usage | undefined, pricing: ModelPricing): number {
  if (!usage) return 0;
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
