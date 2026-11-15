import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The "tighten to allowlist" affordance is a ONE-SHOT migration entry
 * (ADR-0018 Revision 4), and this file pins both halves of that sentence:
 *
 *   1. it renders while the `catch-all-intercepts` finding is present,
 *   2. it is GONE once the finding is gone — no permanently greyed button
 *      sitting under a table that has nothing left to tighten.
 *
 * The finding itself is the backend's (the resolver the live proxy legs call);
 * the page only decides whether to draw the action, which is why the mock here
 * feeds `warnings` straight through.
 */
const getConfig = vi.fn();
const resolveForwardProxyRules = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    resolveForwardProxyRules: (...a: unknown[]) => resolveForwardProxyRules(...a),
    getStatus: vi.fn(async () => ({ forwardProxy: { running: true } })),
    getProxyCaMeta: vi.fn(async () => ({ installed: false })),
    getProxyCaTrust: vi.fn(async () => ({})),
    getSystemProxy: vi.fn(async () => ({})),
    getProxyTimeline: vi.fn(async () => ({ events: [], total: 0 })),
    listGatewayModels: vi.fn(async () => []),
    saveConfig: vi.fn(async () => ({ status: 'ok' })),
    tightenForwardProxyRules: vi.fn(async () => ({ status: 'ok', rules: [], intercept: 'claims', warnings: [] })),
    clearLiveTraffic: vi.fn(async () => ({})),
    deleteProxyHistory: vi.fn(async () => ({})),
    enableSystemProxy: vi.fn(async () => ({})),
    disableSystemProxy: vi.fn(async () => ({})),
  },
}));

import { ProxyAccessPage } from './ProxyAccessPage';
import { I18nProvider } from '../i18n/I18nContext';
import { ToastProvider } from '../components/ToastProvider';
import { ConfirmProvider } from '../components/ConfirmProvider';

// jsdom ships no ResizeObserver; ScrollTable (the claims dialog) measures columns.
if (!('ResizeObserver' in globalThis)) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
}

const CONFIG = {
  forwardProxy: {
    enabled: true,
    port: 4556,
    host: '127.0.0.1',
    intercept: 'claims',
    rules: [{ match: '*', ingress: 'intercept', egress: 'proxy' }],
    // Owned by the Model Fallback page since the split — this page must carry
    // it through its own writes instead of dropping it.
    unresolvedModel: { onMiss: 'direct', hosts: { 'api.example.com': 'fail' } },
  },
};

const resolveWith = (warnings: { code: string; ruleIndex?: number; detail?: string }[], claimed: string[] = []) =>
  async () => ({
    status: 'ok',
    rules: CONFIG.forwardProxy.rules,
    warnings,
    proxyEnabled: true,
    intercept: 'claims',
    claimed,
    claimSources: [],
    decision: { action: 'direct', tunnel: true, reason: 'fallback' },
  });

const renderPage = () =>
  // The page carries one router <Link> (the pointer to the Model Fallback
  // page), so it needs a router in the tree like every other console page.
  render(
    <MemoryRouter initialEntries={['/proxy-access']}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ProxyAccessPage />
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );

describe('ProxyAccessPage — tighten is a one-shot migration entry', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue(CONFIG);
    resolveForwardProxyRules.mockReset();
  });

  it('draws the button while `catch-all-intercepts` is reported', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([{ code: 'catch-all-intercepts', ruleIndex: 0, detail: '*' }]));
    renderPage();

    expect(await screen.findByRole('button', { name: /tighten to allowlist/i })).toBeTruthy();
  });

  it('does not draw it once the table is tight (no finding, no button)', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([], ['a.test']));
    renderPage();

    // Wait on a positive artifact of the resolver round-trip (the OTHER button,
    // which is always drawn when claims exist), then assert this one stayed
    // absent — a `queryBy` right after `render` would pass for the wrong reason.
    await screen.findByRole('button', { name: /1 host name\(s\) decrypted without a rule/i });
    expect(screen.queryByRole('button', { name: /tighten to allowlist/i })).toBeNull();
  });

  it('keeps the claimed-host list behind its own button, not an inline sentence', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([], ['api.ai.jetbrains.com.cn', 'api2.cursor.sh']));
    renderPage();

    expect(await screen.findByRole('button', { name: /2 host name\(s\) decrypted without a rule/i })).toBeTruthy();
  });

  it('carries the Model Fallback policy through a save instead of deleting it', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([], ['a.test']));
    renderPage();

    await screen.findByRole('button', { name: /Save Forward Proxy/i });
    fireEvent.click(screen.getByRole('button', { name: /Save Forward Proxy/i }));

    const saveConfig = (await import('../lib/api')).api.saveConfig as unknown as {
      mock: { calls: [{ forwardProxy: Record<string, unknown> }][] };
    };
    await waitFor(() => expect(saveConfig.mock.calls.length).toBeGreaterThan(0));
    const payload = saveConfig.mock.calls[0][0];
    expect(payload.forwardProxy.unresolvedModel).toEqual({
      onMiss: 'direct',
      hosts: { 'api.example.com': 'fail' },
    });
    expect(payload.forwardProxy.rules).toEqual([{ match: '*', ingress: 'intercept', egress: 'proxy' }]);
  });
});
