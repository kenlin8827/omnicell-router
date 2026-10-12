import { Usage } from '../types/openai.js';
import { ModelPricing } from '../types/router.js';

/**
 * Actual USD cost of one request, computed at request time with the pricing
 * snapshot that was current then. This is the ONLY cost figure OCR records:
 * catalog prices drift (auto-pull overwrites), so a request-time number is a
 * historical fact while a later re-computation would be an approximation.
 * Derived comparisons (baseline / savings) are intentionally NOT computed —
 * they are display metrics and can be re-derived any time from the recorded
 * token counts plus any baseline definition chosen later.
 */
export function computeRequestCost(usage: Usage | undefined, pricing: ModelPricing): number {
  if (!usage) return 0;

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const uncachedInput = Math.max(0, usage.prompt_tokens - cachedTokens);
  const completionTokens = usage.completion_tokens || 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

  const inputCost = (uncachedInput / 1_000_000) * pricing.input;
  const cachedCost = (cachedTokens / 1_000_000) * pricing.cacheRead;

  // A dedicated reasoning surcharge (o-series / extended-thinking pricing)
  // applies only when the catalog declares it; otherwise thinking tokens are
  // billed as plain output — the model-default behavior of every upstream
  // we route to today.
  let outputCost: number;
  if (pricing.reasoning && reasoningTokens > 0) {
    const normalCompletion = Math.max(0, completionTokens - reasoningTokens);
    outputCost =
      (normalCompletion / 1_000_000) * pricing.output +
      (Math.min(completionTokens, reasoningTokens) / 1_000_000) * pricing.reasoning;
  } else {
    outputCost = (completionTokens / 1_000_000) * pricing.output;
  }

  return inputCost + cachedCost + outputCost;
}
