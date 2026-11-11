/**
 * Offline fallback for the npm SDK vocabulary — used ONLY when the
 * `/api/admin/opencode/npm-vocabulary` fetch fails (the endpoint lives in the
 * same gateway process, so this is practically unreachable). Source of truth =
 * backend `providers/vocabulary.ts`; this mirror must list the SAME routable
 * aliases in the SAME order (unroutable SDK-side-signing packages — azure,
 * bedrock, vertex — are deliberately absent). Update both in the same commit.
 */
export interface FallbackNpmEntry {
  alias: string;
  /** Resolved wire — shown as the option's meta text. */
  wire: string;
}

export const FALLBACK_NPM_VOCABULARY: FallbackNpmEntry[] = [
  { alias: '@ai-sdk/openai-compatible', wire: 'openai' },
  { alias: '@ai-sdk/anthropic', wire: 'anthropic' },
  { alias: '@ai-sdk/openai', wire: 'responses' },
  { alias: '@ai-sdk/google', wire: 'google' },
  { alias: '@ai-sdk/typesafe-ai', wire: 'systemone' },
  { alias: '@ai-sdk/xai', wire: 'openai' },
  { alias: '@ai-sdk/mistral', wire: 'openai' },
];
