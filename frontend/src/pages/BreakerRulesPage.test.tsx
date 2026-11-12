import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

/**
 * Two decisions on this page that a screenshot cannot protect:
 *   1. the error-classifier reference is a LOOKUP, not an editing block — it must
 *      stay out of the vertical flow and open from the header as a dialog, so it
 *      never pushes the configurable blocks down the scroll region;
 *   2. that dialog shows the blast radius ONLY. Any disposition it printed would
 *      be the classifier's pre-override default, i.e. advice, while block A owns
 *      the effective one — printing both is how a page ends up with two truths.
 */
const getConfig = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getConfig: (...args: unknown[]) => getConfig(...args),
    saveConfig: vi.fn(),
  },
}));

import { BreakerRulesPage } from './BreakerRulesPage';
import { I18nProvider } from '../i18n/I18nContext';
import { ToastProvider } from '../components/ToastProvider';
import { ConfirmProvider } from '../components/ConfirmProvider';
import type { ClassifierTaxonomyEntry } from '../lib/api';

const CLASSIFIER: ClassifierTaxonomyEntry[] = [
  { category: 'QUOTA_EXHAUSTED', defaultScope: 'credential', disposition: 'hard_trip', countingToggle: false, governedBy: 'trip.quota' },
  { category: 'AUTHENTICATION_ERROR', defaultScope: 'credential', disposition: 'hard_trip', countingToggle: false, governedBy: 'trip.auth', marksSuspect: true },
  { category: 'RATE_LIMITED', defaultScope: 'pair', disposition: 'counted', countingToggle: false, governedBy: 'trip.rateLimit', credentialScope: 'credential', conditionalHardTrip: true },
  { category: 'CLIENT_ERROR', defaultScope: 'model', disposition: 'ignored', countingToggle: true, governedBy: 'counting.clientErrors' },
  { category: 'SERVICE_UNAVAILABLE', defaultScope: 'model', disposition: 'counted', countingToggle: true, governedBy: 'counting.serverErrors', hostScope: 'provider' },
  { category: 'UNKNOWN', defaultScope: 'pair', disposition: 'counted', countingToggle: true, governedBy: 'counting.unknownErrors' },
];

const renderPage = () =>
  render(
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<Outlet context={{ status: { circuitBreakers: { classifier: CLASSIFIER } } }} />}>
                <Route path="/" element={<BreakerRulesPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );

const dialogEl = () => document.querySelector('[data-ocr-dialog]') as HTMLElement | null;

beforeEach(() => {
  localStorage.setItem('ocr_lang', 'en');
  getConfig.mockReset();
  getConfig.mockResolvedValue({ circuitBreaker: {} });
});

describe('breaker-rules classifier reference', () => {
  it('stays out of the page flow until the header button opens it', async () => {
    renderPage();

    // The configurable block A proves the draft has loaded; the reference table
    // must still be absent from the page at that point.
    await screen.findByText('A · When upstream fails this way');
    expect(dialogEl()).toBeNull();
    expect(screen.queryByText('Default radius (auto)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Error classifier reference' }));

    const dialog = dialogEl();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Default radius (auto)');
  });

  it('shows the blast radius only — no disposition column to argue with block A', async () => {
    renderPage();
    await screen.findByText('A · When upstream fails this way');
    fireEvent.click(screen.getByRole('button', { name: 'Error classifier reference' }));

    const heads = Array.from(dialogEl()!.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(heads).toEqual(['Error class', 'Trigger', 'Default radius (auto)']);
    // Six classes, one row each — the reference is the whole taxonomy, not a subset.
    expect(dialogEl()!.querySelectorAll('tbody tr')).toHaveLength(CLASSIFIER.length);
  });
});
