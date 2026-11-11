import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '../i18n/I18nContext';
import { UpdateBanner } from './UpdateBanner';

const renderBanner = (onDismiss: () => void) => {
  localStorage.setItem('ocr_lang', 'en');
  return render(
    <I18nProvider>
      <UpdateBanner
        currentVersion="0.6.0"
        latestVersion="0.7.0"
        releaseUrl="https://github.com/kenlin8827/omnicell-router/releases/tag/v0.7.0"
        onDismiss={onDismiss}
      />
    </I18nProvider>,
  );
};

describe('UpdateBanner', () => {
  it('names both versions and links to the release page', () => {
    renderBanner(() => {});
    expect(screen.getByText('v0.7.0 is available — you are on v0.6.0.')).toBeTruthy();
    const link = screen.getByRole('link', { name: /View release/ });
    expect(link.getAttribute('href')).toBe('https://github.com/kenlin8827/omnicell-router/releases/tag/v0.7.0');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('hands dismissal to the parent', async () => {
    const onDismiss = vi.fn();
    renderBanner(onDismiss);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss until the next version' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
