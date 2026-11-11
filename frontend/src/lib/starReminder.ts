/**
 * Policy + persistence for the GitHub star nudge.
 *
 * Shared by the Overview card (components/StarReminder.tsx) and the header's
 * repository button (components/Layout.tsx), so both read ONE record and the
 * "already starred" state can downgrade the button's tooltip.
 *
 * The record is a plain JSON blob so the whole policy is inspectable and
 * resettable by hand: `localStorage['ocr_star_reminder']`.
 */

export interface StarReminderState {
  /** Times the card has been rendered — the lifetime budget. */
  prompts: number;
  /** Epoch ms of the last showing; the next one waits for the current silence
   *  step, whether the operator ignored the card or closed it. */
  lastShownAt?: number;
  /** Terminal: the CTA was used, so there is nothing left to ask. */
  starred?: boolean;
}

export const STAR_REMINDER_KEY = 'ocr_star_reminder';

/** Requests served before the first ask. */
export const STAR_REMINDER_MIN_REQUESTS = 20;

/** Silence after each showing, in order: the first close buys a week ("busy
 *  this week" is a real answer), then a month, then a quarter. Growing gaps
 *  keep the early ask responsive without turning the card into a weekly ad —
 *  a flat interval has to be either too fast for a daily operator or too slow
 *  to ever be seen again. */
export const STAR_REMINDER_SILENCE_STEPS_MS: readonly number[] = [
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  90 * 24 * 60 * 60 * 1000,
];

/** One showing per silence step, PLUS the first one: the campaign is
 *  day 0 → +7d → +30d → +90d (four showings, ~4 months), then it stops.
 *  There is deliberately no user-facing "never show again". */
export const STAR_REMINDER_MAX_PROMPTS = STAR_REMINDER_SILENCE_STEPS_MS.length + 1;

/** Fired on window after every write so the header button re-reads the state
 *  without a global store (both live in the same document). */
export const STAR_REMINDER_CHANGED_EVENT = 'ocr-star-reminder-changed';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function readStarReminderState(): StarReminderState {
  try {
    const raw = localStorage.getItem(STAR_REMINDER_KEY);
    if (!raw) return { prompts: 0 };
    const parsed = JSON.parse(raw) as Partial<StarReminderState>;
    return {
      prompts: isNumber(parsed.prompts) ? parsed.prompts : 0,
      lastShownAt: isNumber(parsed.lastShownAt) ? parsed.lastShownAt : undefined,
      starred: parsed.starred === true,
    };
  } catch {
    // Storage disabled (private mode / hardened webview): show per load, never
    // persist a verdict — the caller still hides the card for this mount.
    return { prompts: 0 };
  }
}

export function writeStarReminderState(state: StarReminderState): void {
  try {
    localStorage.setItem(STAR_REMINDER_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(STAR_REMINDER_CHANGED_EVENT));
  }
}

export function isStarReminderEligible(state: StarReminderState, requestCount: number, now: number): boolean {
  if (state.starred || requestCount < STAR_REMINDER_MIN_REQUESTS) return false;
  if (state.prompts >= STAR_REMINDER_MAX_PROMPTS) return false;
  // `prompts` counts showings so far, so the current silence window is the
  // step that followed the last one (clamped for a record written by a build
  // with fewer steps).
  const stepIndex = Math.min(Math.max(state.prompts - 1, 0), STAR_REMINDER_SILENCE_STEPS_MS.length - 1);
  return now - (state.lastShownAt ?? 0) >= STAR_REMINDER_SILENCE_STEPS_MS[stepIndex];
}

/** True once the operator used the CTA — the header button then drops its
 *  "star us" wording and stays a plain repository link. */
export function isStarNudgeDone(): boolean {
  return readStarReminderState().starred === true;
}
