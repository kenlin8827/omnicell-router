import React, { useEffect, useRef, useState } from 'react';
import { Github, Star, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { GITHUB_REPO_URL } from '../lib/links';
import { openExternal } from '../lib/openExternal';
import {
  STAR_REMINDER_MAX_PROMPTS,
  isStarReminderEligible,
  readStarReminderState,
  writeStarReminderState,
} from '../lib/starReminder';

/**
 * Overview-page "star the repository on GitHub" card.
 *
 * Two actions, no permanent opt-out:
 * - the CTA opens GitHub and retires the card for good (the operator said yes —
 *   a star cannot be verified without an OAuth grant, so a click is taken at
 *   face value);
 * - × hides it for the current silence step (7 days, 30, then 90) — closing is
 *   a pause, not a rejection, which is why there is no "never show again"
 *   button and no consent screen behind it. The card ends after the steps run
 *   out (~4 months).
 *
 * Ignoring the card (leaving the page) spends a showing too, so navigating
 * away is not a way to farm free re-prompts.
 *
 * Policy and storage live in lib/starReminder.ts (shared with the header's
 * repository button).
 */
export const StarReminder: React.FC<{ requestCount: number }> = ({ requestCount }) => {
  const { t } = useI18n();
  const [state, setState] = useState(readStarReminderState);
  const [hidden, setHidden] = useState(false);

  const eligible = !hidden && isStarReminderEligible(state, requestCount, Date.now());

  // Spend one showing per mount. The write is persisted WITHOUT touching
  // `state`, so the card is not yanked out from under the operator the moment
  // the last budget unit is consumed — the policy only applies to the next
  // visit, which reads the stored record.
  const spent = useRef(false);
  useEffect(() => {
    if (!eligible || spent.current) return;
    spent.current = true;
    const stored = readStarReminderState();
    if (stored.starred || stored.prompts >= STAR_REMINDER_MAX_PROMPTS) return;
    writeStarReminderState({ ...stored, prompts: stored.prompts + 1, lastShownAt: Date.now() });
  }, [eligible]);

  if (!eligible) return null;

  return (
    <section className="card star-reminder" aria-label={t('starReminder.title')}>
      <span className="star-reminder-icon" aria-hidden="true"><Star size={17} /></span>
      <div className="star-reminder-copy">
        <strong>{t('starReminder.title')}</strong>
        <p>{t('starReminder.body')}</p>
      </div>
      <div className="star-reminder-actions">
        {/* A button, not an anchor: retiring the nudge and opening the
            browser must both run, and the desktop shell's external-link
            interceptor swallows anchor clicks before React sees them. */}
        <button type="button" className="btn btn-primary btn-sm"
          onClick={() => {
            setState((prev) => {
              const next = { ...prev, starred: true };
              writeStarReminderState(next);
              return next;
            });
            openExternal(GITHUB_REPO_URL);
          }}>
          <Github size={14} /><span>{t('starReminder.cta')}</span>
        </button>
        <button type="button" className="star-reminder-dismiss" onClick={() => setHidden(true)}
          title={t('starReminder.dismiss')} aria-label={t('starReminder.dismiss')}>
          <X size={15} />
        </button>
      </div>
    </section>
  );
};
