import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The page owns exactly ONE key inside `forwardProxy` — `unresolvedModel` — and
 * the inbound-proxy page saves that whole section, so the two must not clobber
 * each other. This file pins the save shape: a write from here carries the
 * freshly-read section through and replaces only its own key.
 */
const getConfig = vi.fn();
const saveConfig = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    saveConfig: (...a: unknown[]) => saveConfig(...a),
    listGatewayModels: vi.fn(async () => [
      { id: 'claude-sonnet-4', kind: 'model', wire: 'chat' },
      { id: 'auto', kind: 'alias' },
    ]),
  },
}));

import { ModelFallbackPage } from './ModelFallbackPage';
import { I18nProvider } from '../i18n/I18nContext';
import { ToastProvider } from '../components/ToastProvider';

const CONFIG = {
  forwardProxy: {
    enabled: true,
    port: 4556,
    rules: [{ match: 'api.anthropic.com', ingress: 'intercept', egress: 'direct' }],
    unresolvedModel: { onMiss: 'fail', hosts: { 'api.example.com': 'direct' } },
  },
};

const renderPage = () =>
  render(
    <I18nProvider>
      <ToastProvider>
        <ModelFallbackPage />
      </ToastProvider>
    </I18nProvider>,
  );

describe('ModelFallbackPage', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue(CONFIG);
    saveConfig.mockReset().mockResolvedValue({ status: 'ok' });
  });

  it('saves by merging into the freshly-read forwardProxy section', async () => {
    renderPage();

    // Loaded policy is shown, and the page starts clean (Save disabled).
    await screen.findByText('Unresolved model-name policy');
    expect(screen.getByDisplayValue('api.example.com')).toBeTruthy();
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Editing a host makes it dirty; the save must then carry the sibling keys
    // (rules / port / enabled) through untouched — this page owns one key only.
    fireEvent.change(screen.getByDisplayValue('api.example.com'), { target: { value: 'api2.example.com' } });
    await waitFor(() => expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    const payload = saveConfig.mock.calls[0][0] as { forwardProxy: Record<string, unknown> };
    expect(payload.forwardProxy.enabled).toBe(true);
    expect(payload.forwardProxy.port).toBe(4556);
    expect(payload.forwardProxy.rules).toEqual(CONFIG.forwardProxy.rules);
    expect(payload.forwardProxy.unresolvedModel).toEqual({
      onMiss: 'fail',
      hosts: { 'api2.example.com': 'direct' },
    });
  });
});
