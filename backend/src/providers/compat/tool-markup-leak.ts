/**
 * Detection of upstreams that leak their own tool-call MARKUP as text.
 *
 * Some model families have no native tool-call channel on the wire: they write
 * the call into the message body and expect the API in front of the model to
 * convert it. DeepSeek V4 writes `<|tool_calls|>` / `<|invoke name="…">` (with
 * an optional `DSML` marker), and a relay that does not run the converter hands
 * that markup to the client as ordinary content — the client sees tags, and the
 * model, reading its own markup back from history, loops.
 *
 * OBSERVE ONLY within this module: detection never edits a response. The
 * narrowly-scoped, validated recovery in `providers/compat/tool-markup-recovery.ts`
 * runs first; this detector then counts only residual markup (unscoped,
 * malformed, truncated or schema-invalid), preserving a visible signal for the
 * operator (ADR-0034). Detection itself is therefore safe to run on every
 * provider at full stream speed, independently of whether a response is
 * eligible for recovery.
 *
 * Lives beside recovery on the provider execution boundary — not in `ir/`.
 */
import type { CanonicalResponse } from '../../ir/types.js';

/** How many leaked tool-call blocks one response carried. */
export interface ToolMarkupLeak {
  calls: number;
}

/**
 * One opening `invoke` tag in any spelling seen in the wild — the `DSML` marker
 * is OPTIONAL (`<|DSML|invoke name="x">` on some channels, a bare
 * `<|invoke name="x">` on others), and the pipe separators may be full-width,
 * doubled, or absent.
 */
const INVOKE_OPEN = /<[|\uFF5C\s]*(?:DSML[|\uFF5C\s]*)?invoke\b[^>]*>/gi;

/** Count the leaked calls in one text. */
export function countToolMarkupLeak(text: string): number {
  return [...text.matchAll(INVOKE_OPEN)].length;
}

/**
 * Scan a buffered response. Returns null when nothing leaked, so a caller can
 * stamp the result unconditionally.
 */
export function detectToolMarkupLeak(response: CanonicalResponse): ToolMarkupLeak | null {
  // Tolerant of a stub/partial response: this runs on the return path of every
  // provider call, so it must never be the thing that throws.
  if (!response || !Array.isArray(response.output)) return null;
  let calls = 0;
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'text') calls += countToolMarkupLeak(part.text);
    }
  }
  return calls > 0 ? { calls } : null;
}

/**
 * Incremental scanner for the streaming leg, where no full response exists at
 * the time the bytes leave. Feed every text delta; ask afterwards. The tail
 * window is what lets a tag split across two deltas still match.
 */
export function createToolMarkupScanner(): { push: (text: string) => void; leak: () => ToolMarkupLeak | null } {
  let calls = 0;
  let tail = '';
  return {
    push(text: string): void {
      if (!text) return;
      const probe = tail + text;
      for (const match of probe.matchAll(INVOKE_OPEN)) {
        // Only count a match that ENDS past the retained tail, otherwise every
        // push would re-count the previous delta's tag.
        if ((match.index ?? 0) + match[0].length > tail.length) calls += 1;
      }
      tail = probe.slice(-200);
    },
    leak(): ToolMarkupLeak | null {
      return calls > 0 ? { calls } : null;
    },
  };
}
