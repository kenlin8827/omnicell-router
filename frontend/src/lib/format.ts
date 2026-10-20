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

/** Clipboard write with boolean outcome (pages surface success/error toasts). */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Decode throughput (industry TPS): completion tokens per second of the
 * generation window — first forwarded chunk → stream fully drained. TTFT,
 * prefill and any failed attempts before the commit are excluded, matching
 * OpenRouter's throughput definition ("output tokens per second after
 * generation starts"). Null when the turn never streamed (genMs missing on a
 * buffered turn or a replayed pre-field row) — callers render '—', never a
 * synthesized number.
 */
export const decodeRate = (outputTokens: number, genMs: number | undefined | null): number | null =>
  outputTokens > 0 && typeof genMs === 'number' && genMs > 0 ? (outputTokens / genMs) * 1000 : null;

/**
 * Effective end-to-end rate, CAPTURE DOMAIN ONLY (CapturesPage): completion
 * tokens per second of the full request latency. Trace-domain surfaces use
 * `decodeRate` instead — this denominator includes queueing, routing and
 * retries, and capture turns carry no decode timing to divide by.
 */
export const outputRate = (outputTokens: number, latencyMs: number): number | null =>
  outputTokens > 0 && latencyMs > 0 ? (outputTokens / latencyMs) * 1000 : null;

/** Compact tok/s label: whole number at ≥ 10, one decimal below; null → '—'. */
export const formatRate = (rate: number | null): string =>
  rate === null ? '—' : rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);

/**
 * Recorded-cost display: 2–6 fraction digits with trailing zeros trimmed
 * ($0.000123 per-request precise, $2.50 aggregate-clean). en-US fixed so
 * the grouping stays stable across locales (labels are translated, numbers
 * are data).
 */
export const formatCost = (usd: number): string =>
  '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

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
