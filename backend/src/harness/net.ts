/**
 * Failure vocabulary shared by every reader, plus the English sentence that stands in for it, plus
 * the ONE retry policy a market read applies before it reports that sentence.
 *
 * A runtime's own message ("The socket connection was closed unexpectedly. For more information, pass
 * `verbose: true` in the second argument to fetch()") names no subject, states no consequence, and
 * prescribes an option this console cannot set: diagnostics for us, prose for nobody. Every reader
 * therefore reports a `FailureReason` the console can TRANSLATE, keeps `message` as the English
 * fallback (an unmapped reason still shows a sentence, never a key), and drops the runtime text — the
 * coarse failure class stays in `code`, which is what code branches on.
 */
export type FailureReason =
  /** The request never reached an answer (reset, DNS, refused). */
  | 'network'
  /** The request was still running when its deadline expired. */
  | 'timeout'
  /** The upstream answered a status this reader cannot use; `reasonParams.status` carries it. */
  | 'http'
  /** The upstream asked us to slow down; a token or a later retry is the operator's move. */
  | 'rateLimited'
  /** Throttled or broken upstream — the same call is expected to work later. */
  | 'unavailable'
  /** The page answered 200 but no longer carries what this reader parses (undocumented markup). */
  | 'markupChanged'
  /** The answer was not the shape this reader decodes (non-JSON, wrong envelope). */
  | 'badPayload'
  /** No adapter serves this source at all. */
  | 'unsupportedSource';

/** The reason half of a failed read, keyed to a console translation. */
export function fetchFailureReason(error: unknown): FailureReason {
  const name = error instanceof Error ? error.name : '';
  // AbortSignal.timeout() aborts the request, so a timeout surfaces as an AbortError/TimeoutError.
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
}

/** The English fallback sentence for `fetchFailureReason(error)`. */
export function describeFetchFailure(subject: string, error: unknown): string {
  return fetchFailureReason(error) === 'timeout'
    ? `${subject} timed out — try again in a moment`
    : `${subject} could not be reached — check the network connection and try again`;
}

/**
 * How a market read retries a FAILED answer, declared once for every reader.
 *
 * A market read is an idempotent GET, so ANY failed answer earns another ask while attempts and
 * budget last — a thrown reset, a 5xx, and also a 4xx: npm's CDN answers a transient 404 while a
 * publish propagates, and a 403/429 can be a burst window shorter than the backoff. The one early
 * return left is a `Retry-After` the remaining budget cannot fit: the server named a wait the
 * policy cannot honor, so another ask is provably futile and the answer comes back at once. A
 * `Retry-After` that DOES fit floors the next sleep instead, so the retry does not land inside
 * the window it was told about.
 *
 * `attempts` is a CEILING, `budgetMs` is the contract: an attempt's deadline is whatever is left of
 * the budget, so five attempts of a fast-failing endpoint fit inside 30 s with room to spare, while
 * a hard timeout spends the budget on about four 6 s tries and the caller gets its `timeout` when
 * the 30 s are gone — never later, because the budget caps the sleeps too.
 */
export interface RetryPolicy {
  /** Attempts including the first. */
  attempts: number;
  /** Delay before the FIRST retry; later delays multiply by `factor`. */
  firstDelayMs: number;
  factor: number;
  /** Total wall clock across every attempt and every sleep. */
  budgetMs: number;
  /** Per-attempt deadline (further capped by whatever remains of `budgetMs`). */
  timeoutMs: number;
}

/**
 * The market-read policy: 5 attempts, 400 ms → 800 ms → 1.6 s → 3.2 s (±20 % jitter), 6 s per
 * attempt, 30 s total.
 *
 * Worst case is therefore ~30 s of operator-visible latency — the ceiling the operator accepted
 * (2026-10-25): a hard-hanging upstream gets about four full 6 s attempts before the budget runs
 * out, a fast-failing one (a reset after ~50 ms) gets all five asks inside ~7 s, and a single
 * blip is still repaired in under half a second.
 */
export const MARKET_RETRY: RetryPolicy = {
  attempts: 5,
  firstDelayMs: 400,
  factor: 2,
  budgetMs: 30_000,
  timeoutMs: 6_000,
};

/** An attempt is not worth starting with less than this left — it would time out on arrival. */
const MIN_ATTEMPT_MS = 1_000;
/** Jitter keeps a page that fires several reads at once from retrying in lockstep. */
const JITTER = 0.2;

/**
 * The server's own "ask again after N seconds", or 0 when the answer carries no usable
 * `Retry-After` (an HTTP-date is not parsed — the plain backoff applies then, bounded by the
 * budget like everything else).
 */
function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
}

export interface RetryDeps {
  /** Test seam: the existing `fetchImpl` parameter every reader already accepts. */
  fetchImpl?: typeof fetch;
  /** Test seam: a no-op here keeps a retry test from actually sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fetch` with the market retry policy applied.
 *
 * The helper OWNS the per-attempt deadline (a caller-supplied `signal` is replaced): one shared
 * timeout per attempt is what makes the budget arithmetic above true.
 *
 * It returns the LAST response whatever its status — mapping a status to `FailureReason` stays the
 * caller's job, so no reader loses the vocabulary it already reports. When every attempt threw, the
 * last error is rethrown and the caller's existing `catch` produces the sentence, unchanged.
 */
export async function fetchWithRetry(
  input: string,
  init: RequestInit = {},
  policy: RetryPolicy = MARKET_RETRY,
  deps: RetryDeps = {}
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const started = Date.now();
  let delay = policy.firstDelayMs;
  /** A `Retry-After` the last answer asked for: the next sleep may not dip below it. */
  let sleepFloorMs = 0;
  let lastError: unknown;
  let lastResponse: Response | undefined;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    if (attempt > 1) {
      const left = policy.budgetMs - (Date.now() - started);
      if (left <= MIN_ATTEMPT_MS) break;
      // Jitter, then never sleep away the floor an attempt needs — nor below the server's ask.
      const jittered = Math.max(delay * (1 - JITTER + Math.random() * JITTER * 2), sleepFloorMs);
      sleepFloorMs = 0;
      await sleep(Math.max(Math.min(jittered, left - MIN_ATTEMPT_MS), 0));
      delay *= policy.factor;
    }

    const left = policy.budgetMs - (Date.now() - started);
    const timeoutMs = Math.min(policy.timeoutMs, Math.max(left, MIN_ATTEMPT_MS));
    try {
      lastResponse = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastError = e;
      continue;
    }
    // A successful answer ends the loop at once — only a FAILED one is ever asked again. The last
    // attempt's answer, whatever its status: hand it back untouched.
    if (lastResponse.ok || attempt === policy.attempts) return lastResponse;
    // Every OTHER answer earns another ask — but one more attempt has to fit, sleep included, and
    // a `Retry-After` the remaining budget cannot cover makes that ask provably futile. A
    // `Retry-After` that fits floors the upcoming sleep instead.
    const raMs = retryAfterMs(lastResponse);
    if (policy.budgetMs - (Date.now() - started) <= MIN_ATTEMPT_MS + Math.max(delay, raMs)) {
      return lastResponse;
    }
    sleepFloorMs = raMs;
    // Release the discarded body so the retry is not queued behind an unread socket — and drop the
    // reference: a cancelled response must never be handed back as if it were a real answer.
    const stale = lastResponse;
    lastResponse = undefined;
    try {
      await stale.body?.cancel();
    } catch {
      // A body already consumed/errored needs no cancel; the retry proceeds either way.
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new Error('market read failed with no attempt completed');
}
