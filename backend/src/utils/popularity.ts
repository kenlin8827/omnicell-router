import type { SupportedClient } from '../cli/types.js';
import type { HarnessHostId } from '../harness/types.js';

/**
 * ONE popularity order for every runtime this build lists — the Clients page's
 * one-click roster and the harness artifact rail share it, so the two surfaces
 * can never disagree about which product is more popular.
 *
 * Evidence (researched 2026-11-10):
 *  - gradually.ai AI-harness popularity index, 2026-11-09: Claude Code 93,
 *    Cursor/Codex 83, Antigravity/Zed 81, Pi 75, OpenCode 73, Gemini CLI 69,
 *    Windsurf/Cline 65, Amp/Kimi 58, omp 55, Grok 52, Qoder 48, Factory 44.
 *  - Near-ties (≤3 index points) are resolved by direct install/usage signals:
 *    JetBrains Developer Ecosystem Survey 2026 (at-work share), weekly npm
 *    downloads 2026-11-03..09 (`@openai/codex` 26.1M, Claude Code 15.3M,
 *    OpenCode 3.3M, omp 225k, Pi 405k, Cline 99k, Amp 27k, Kimi 2.2k), and
 *    OpenRouter 30-day tokens (Cline 20.0T, Pi 12.3T, omp 10.4T, OpenClaw 6.96T).
 *    That moves Codex above Cursor, OpenCode above Pi, and Amp/omp above Kimi.
 *  - Not covered by the index: DeepSeek Harness (278k GitHub stars in its first
 *    three months, 2026-11-10) ranks between the 81 and 75 tiers; OpenClaw
 *    (394k stars, but personal-agent traffic) ranks below OpenCode/Pi.
 *    WorkBuddy (Tencent's office-agent IDE) has no index figure — it sits with
 *    the other vendor IDEs between Grok and Qoder by judgment, not measurement.
 *
 * Aliases share their product's row (`cursor-proxy` = Cursor,
 * `opencode-proxy` = OpenCode, `qoder-proxy` = Qoder). `universal` is not a
 * product and is deliberately absent — the rail pins it first by id. A runtime
 * absent here sorts after every ranked one (the host catalog breaks the tie).
 */
type RankedRuntimeId = SupportedClient | Exclude<HarnessHostId, 'universal'>;

const POPULARITY_ROWS: readonly (readonly RankedRuntimeId[])[] = [
  ['claude'],
  ['codex'],
  ['cursor', 'cursor-proxy'],
  ['antigravity'],
  ['zed'],
  ['dsh'],
  ['opencode', 'opencode-proxy'],
  ['pi'],
  ['openclaw'],
  ['gemini-cli'],
  ['windsurf'],
  ['cline'],
  ['amp'],
  ['omp'],
  ['kimi'],
  ['grok'],
  ['workbuddy'],
  ['qoder-proxy'],
  ['factory'],
];

const RANK = new Map<string, number>();
POPULARITY_ROWS.forEach((row, index) => {
  for (const id of row) RANK.set(id, index + 1);
});

/** Sort key for an unranked runtime — after every row above. */
export const POPULARITY_UNRANKED = POPULARITY_ROWS.length + 1;

/** 1 = most popular. Unknown ids (and `universal`) return `POPULARITY_UNRANKED`. */
export function popularityRank(id: string): number {
  return RANK.get(id) ?? POPULARITY_UNRANKED;
}
