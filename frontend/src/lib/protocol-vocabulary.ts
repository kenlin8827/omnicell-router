/**
 * Offline fallback for the OCR protocol vocabulary — used ONLY when the
 * `/api/admin/opencode/protocol-vocabulary` fetch fails (the endpoint lives in
 * the same gateway process, so this is practically unreachable). Source of
 * truth = backend `providers/vocabulary.ts`; this mirror must list the SAME
 * routable CORE protocol ids in the SAME order (unroutable SDK-side-signing
 * protocols — azure, bedrock, vertex — are deliberately absent).
 *
 * Plugin-owned protocols are deliberately NOT mirrored: the backend derives
 * their rows from the loaded plugin registry, so an offline list would be a
 * claim about what is installed — exactly the drift the derivation removes.
 * Update both in the same commit.
 */
export interface FallbackProtocolEntry {
  alias: string;
  /** Resolved wire — identical to `alias` now (protocol id = wire id); kept
   *  so the offline mirror matches the backend entry shape. */
  wire: string;
}

export const FALLBACK_PROTOCOL_VOCABULARY: FallbackProtocolEntry[] = [
  { alias: 'openai-chat', wire: 'openai-chat' },
  { alias: 'anthropic-messages', wire: 'anthropic-messages' },
  { alias: 'openai-responses', wire: 'openai-responses' },
  { alias: 'google-gemini', wire: 'google-gemini' },
  { alias: 'systemone', wire: 'systemone' },
];
