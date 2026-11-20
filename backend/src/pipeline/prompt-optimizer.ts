import type { CanonicalRequest, InputItem, Usage } from '../ir/types.js';

export class PromptOptimizer {
  /**
   * Stable system/developer prefix with lossless items. Carrier adapters own
   * any protocol-required joining; this layer never trims text, rewrites roles
   * or discards structured parts and their cache metadata.
   */
  public static normalizeMessages(request: CanonicalRequest): InputItem[] {
    const prefix = request.input.filter((item) =>
      item.type === 'message' && (item.role === 'system' || item.role === 'developer'));
    if (prefix.length === 0) return request.input;
    const other = request.input.filter((item) =>
      item.type !== 'message' || (item.role !== 'system' && item.role !== 'developer'));
    return [...prefix, ...other];
  }

  public static extractCachedTokens(usage?: Usage): number {
    return usage?.cachedInputTokens ?? 0;
  }
}
