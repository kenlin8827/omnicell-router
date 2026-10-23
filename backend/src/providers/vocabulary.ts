/**
 * The npm SDK vocabulary — ONE table, served to the console over
 * `/api/admin/opencode/npm-vocabulary` so every UI surface (custom-provider
 * form dropdown, model-level npm editor, display-name mapping) renders the
 * SAME list in the SAME order without keeping a second copy in frontend code.
 *
 * Consistency contracts (pinned by vocabulary.test.ts):
 *   - `wireFor(alias) === wireFor(package)` for every entry — the v1 alias and
 *     the opencode v2 package MUST resolve to the same wire;
 *   - every opencode v2 segment here is recognized by wire.ts's
 *     OPENCODE_V2_SEGMENT_WIRES (no invented segments);
 *   - `order` is the UI dropdown order: chat-wire majors first, the special
 *     wires (decision / SDK-side construction) after.
 */
import { wireFor } from './wire.js';

export interface NpmVocabularyEntry {
  /** The v1 alias users type (`@ai-sdk/<x>`). */
  alias: string;
  /** The opencode v2 `package` shape stored in the defs file (ADR-0010). */
  package: string;
  /** Resolved wire — informational for the UI, authoritative in wireFor(). */
  wire: string;
  /** UI dropdown order (ascending). */
  order: number;
}

const RAW_ENTRIES: Omit<NpmVocabularyEntry, 'wire'>[] = [
  { alias: '@ai-sdk/openai-compatible', package: '@opencode/ai/providers/openai-compatible', order: 10 },
  { alias: '@ai-sdk/anthropic', package: '@opencode/ai/providers/anthropic', order: 20 },
  { alias: '@ai-sdk/openai', package: '@opencode/ai/providers/openai', order: 30 },
  { alias: '@ai-sdk/google', package: '@opencode/ai/providers/google', order: 40 },
  // The TypeSafe decision alias is OFFERED. Its opencode v2 segment is real on
  // the read side (wire.ts maps it to wire `systemone`), so a def authored from
  // this npm keeps the decision wire end to end. The client copy is still made
  // loadable by CLIENT_PACKAGE_FALLBACK (def-materialize.ts) — offering the
  // alias must not depend on the client having shipped the segment.
  { alias: '@ai-sdk/typesafe-ai', package: '@opencode/ai/providers/typesafe', order: 50 },
  { alias: '@ai-sdk/azure', package: '@opencode/ai/providers/azure', order: 60 },
  { alias: '@ai-sdk/amazon-bedrock', package: '@opencode/ai/providers/amazon-bedrock', order: 70 },
  // Catalog-only chat packages (plain openai wire) — kept for the dropdown's
  // offline fallback completeness; they carry no special wire semantics.
  { alias: '@ai-sdk/xai', package: '@ai-sdk/xai', order: 80 },
  { alias: '@ai-sdk/mistral', package: '@ai-sdk/mistral', order: 90 },
];

export const NPM_VOCABULARY: NpmVocabularyEntry[] = RAW_ENTRIES.map((e) => ({
  ...e,
  wire: wireFor(e.alias),
}));

/** opencode v2 `package` (or passthrough npm) → the display v1 alias. */
export function vocabularyAliasFor(npm: string): string {
  const hit = NPM_VOCABULARY.find((e) => e.package === npm || e.alias === npm);
  return hit ? hit.alias : npm;
}
