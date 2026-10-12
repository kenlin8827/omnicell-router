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
 * Recorded-cost display: 2–6 fraction digits with trailing zeros trimmed
 * ($0.000123 per-request precise, $2.50 aggregate-clean). en-US fixed so
 * the grouping stays stable across locales (labels are translated, numbers
 * are data).
 */
export const formatCost = (usd: number): string =>
  '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
