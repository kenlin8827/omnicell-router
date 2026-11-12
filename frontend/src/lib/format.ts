/**
 * Small shared display helpers for console pages.
 */

/**
 * Session IDs are client-supplied verbatim (explicit session header wins) and
 * some clients send a whole JSON blob (e.g. {"device_id":"...","account_uuid":
 * "","session_id":"<uuid>"}). For display, extract the inner session_id when
 * parseable; otherwise show the id in full (never middle-abbreviated — users
 * need to match ids across pages). Long ids wrap via the table's word-break.
 */
export const formatSessionId = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string' && parsed.session_id) {
      return parsed.session_id;
    }
  } catch {
    /* plain string id */
  }
  return raw;
};

/**
 * Head-truncated id for dense lists (GitHub short-SHA style): first `n`
 * chars + ellipsis. Pair with a full-value tooltip; search accepts fragments.
 */
export const shortId = (id: string, n = 16): string =>
  id.length <= n ? id : `${id.slice(0, n)}…`;

/**
 * Output speed (industry "tokens per second", the inverse of TPOT): completion
 * tokens per second of the decode window — first forwarded chunk → stream
 * fully drained. TTFT, prefill and any failed attempts before the commit are
 * excluded, which is the boundary OTel's `time_per_output_token` and
 * Artificial Analysis' per-query speed use. Note OpenRouter's `Throughput` is
 * a WIDER window (request sent → last token — TTFT included), so its figure
 * reads lower for the same model and the two must never be compared directly;
 * the console states this in the column tooltip.
 * Null when the turn never streamed (genMs undefined) — callers render '—',
 * never a synthesized number.
 */
export const decodeRate = (outputTokens: number, genMs: number | undefined): number | null =>
  outputTokens > 0 && typeof genMs === 'number' && genMs > 0 ? (outputTokens / genMs) * 1000 : null;

/** Compact tok/s label: whole number at ≥ 10, one decimal below; null → '—'. */
export const formatRate = (rate: number | null): string =>
  rate === null ? '—' : rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);

/**
 * Output-speed label for a token-per-second figure. Kept separate from
 * `formatRate` because this one is a serving metric shown next to latencies:
 * a 4-digit value would overflow its column, so ≥1000 collapses to 1.2K.
 * The value is output tokens ÷ decode window (first streamed chunk → stream
 * end) — OTel's `time_per_output_token` inverted, and the same "per query,
 * after the first token" boundary Artificial Analysis uses for its
 * agentic/system load tests. OpenRouter's `Throughput` is a WIDER window
 * (request sent → last token) and therefore reads lower for the same model;
 * the tooltip states this so nobody compares the two directly.
 */
const SPEED_COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export const formatSpeed = (rate: number | null): string =>
  rate === null ? '—' : rate >= 1000 ? SPEED_COMPACT.format(rate) : formatRate(rate);

/**
 * Recorded-cost display: 2–6 fraction digits with trailing zeros trimmed
 * ($0.000123 per-request precise, $2.50 aggregate-clean). en-US fixed so
 * the grouping stays stable across locales (labels are translated, numbers
 * are data).
 */
export const formatCost = (usd: number): string =>
  '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * Dense-table cost label. Same intent as `formatCost`, but capped at the width
 * a fixed column can actually hold: sub-dollar figures keep their 6 decimals
 * (that is where precision carries information — $0.000123 vs $0.000124), and
 * dollar-and-above figures stop at 2, because `$267.469544` (11 glyphs) is
 * wider than any sane cost column and the excess decimals never matter at that
 * magnitude. Pair with `formatCost` in the cell's tooltip for the exact value.
 */
export const formatCostCompact = (usd: number): string =>
  '$' +
  usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(usd) >= 1 ? 2 : 6,
  });

/**
 * Smart-unit latency label for stats displays: sub-second stays in ms,
 * seconds keep one decimal (7020 → "7.0s", 13526 → "13.5s"), then m s / h m.
 * Callers keep the exact raw ms in a title tooltip since the label rounds.
 */
export const fmtLatency = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to whole seconds/minutes first — per-field rounding would strand
  // carries like 59m 60s or 119.6s → 1m 60s.
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 3_600) return `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, '0')}s`;
  const totalMin = Math.round(ms / 60_000);
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`;
};

/** Compact duration ("45s" / "3m" / "2h" / "5d") — quota windows and reset
 *  countdowns share this shape. */
export const fmtDur = (ms: number): string => {
  if (ms <= 0) return '0s';
  const s = ms / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
};

/**
 * Readable label for a machine key, used where the wire carries only an
 * identifier (plugin `configSchema[].key`, whose manifest may ship no `title`
 * or only a locale map for another language). camelCase, snake_case and
 * kebab-case all collapse to spaced words with a capitalized head
 * ('previewBytes' → 'Preview bytes', 'max_result_chars' → 'Max result chars').
 *
 * This is a FALLBACK, not a translation: it invents no vocabulary, and callers
 * keep rendering the exact key alongside it — the key is what backend warnings
 * quote and what `<ocrHome>/plugins/config/<id>.json` stores.
 */
export const humanizeKey = (key: string): string => {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return key;
  const spaced = words.join(' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};
