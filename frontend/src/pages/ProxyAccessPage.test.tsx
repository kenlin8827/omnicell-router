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
const getProxyCaMeta = vi.fn();
const copyToClipboard = vi.fn();
const getSystemProxy = vi.fn();
const disableSystemProxy = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    resolveForwardProxyRules: (...a: unknown[]) => resolveForwardProxyRules(...a),
    getStatus: vi.fn(async () => ({ forwardProxy: { running: true } })),
    getProxyCaMeta: (...a: unknown[]) => getProxyCaMeta(...a),
    getProxyCaTrust: vi.fn(async () => ({})),
    getSystemProxy: (...a: unknown[]) => getSystemProxy(...a),
    getProxyTimeline: vi.fn(async () => ({ events: [], total: 0 })),
    listGatewayModels: vi.fn(async () => []),
    saveConfig: vi.fn(async () => ({ status: 'ok' })),
    tightenForwardProxyRules: vi.fn(async () => ({ status: 'ok', rules: [], intercept: 'claims', warnings: [] })),
    clearLiveTraffic: vi.fn(async () => ({})),
    deleteProxyHistory: vi.fn(async () => ({})),
    enableSystemProxy: vi.fn(async () => ({})),
    disableSystemProxy: (...a: unknown[]) => disableSystemProxy(...a),
  },
}));

vi.mock('../lib/clipboard', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
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
    // A key this page does not render: a save must carry it through (the
    // whole section is written, so a dropped key would silently delete it).
    accessLog: { enabled: true, persist: false },
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
    // No CA meta: the wizard stays on its loading label, which is all these
    // tests need (they exercise the rule table, not the trust steps).
    getProxyCaMeta.mockReset().mockResolvedValue(undefined);
    getSystemProxy.mockReset().mockResolvedValue({ state: 'off', proxyEnabled: true });
    disableSystemProxy.mockReset().mockResolvedValue({ state: 'off', proxyEnabled: false });
    copyToClipboard.mockReset();
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

  it('carries unrendered forwardProxy keys through a save instead of deleting them', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([], ['a.test']));
    renderPage();

    await screen.findByRole('button', { name: /Save Forward Proxy/i });
    fireEvent.click(screen.getByRole('button', { name: /Save Forward Proxy/i }));

    const saveConfig = (await import('../lib/api')).api.saveConfig as unknown as {
      mock: { calls: [{ forwardProxy: Record<string, unknown> }][] };
    };
    await waitFor(() => expect(saveConfig.mock.calls.length).toBeGreaterThan(0));
    const payload = saveConfig.mock.calls[0][0];
    expect(payload.forwardProxy.accessLog).toEqual({ enabled: true, persist: false });
    expect(payload.forwardProxy.rules).toEqual([{ match: '*', ingress: 'intercept', egress: 'proxy' }]);
  });
});

/**
 * The setup wizard's whole job is to hand the operator commands to type —
 * env-var snippets, per-OS trust imports. Each one is one click from the
 * clipboard: the well has an overlay glyph, every OS row has one beside the
 * command, and what lands on the clipboard is the command WITH this
 * install's real CA path interpolated (not the `<appData>` placeholder and
 * not the loading label).
 */
describe('ProxyAccessPage — setup wizard commands are copyable', () => {
  const CA_PATH = 'D:/ocr-home/forward-proxy/ca.pem';

  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue(CONFIG);
    resolveForwardProxyRules.mockReset();
    getProxyCaMeta.mockReset().mockResolvedValue({
      path: CA_PATH,
      fingerprintSha256: 'AA:BB:CC',
      subject: 'CN=OmniCellRouter Root CA',
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2036-01-01T00:00:00Z',
    });
    copyToClipboard.mockReset().mockResolvedValue(true);
  });

  it('puts the snippet and every OS trust command one click from the clipboard', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([]));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Setup Wizard' }));

    // Shell side is the default: every OS install command is drawn and
    // copyable before any tab is touched.
    const glyphs = await screen.findAllByTitle('Copy');
    for (const g of glyphs) fireEvent.click(g);

    // Code side: one sub-tab click, then the env snippet is copyable too.
    fireEvent.click(screen.getByRole('button', { name: 'Code clients' }));
    const codeGlyphs = await screen.findAllByTitle('Copy');
    for (const g of codeGlyphs) fireEvent.click(g);

    const copied = copyToClipboard.mock.calls.map(c => c[0] as string);
    expect(copied.some(text => text.includes('NODE_EXTRA_CA_CERTS') && text.includes(CA_PATH))).toBe(true);
    expect(copied.some(text => text.includes('certutil') && text.includes(CA_PATH))).toBe(true);
  });

  it('keeps the shell and code trust routes on separate sub-tabs', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([]));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Setup Wizard' }));

    // Default = shell: store commands visible, the code snippet is NOT.
    expect((await screen.findAllByText(/certutil/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/NODE_EXTRA_CA_CERTS/)).toBeNull();

    // Switch to code: env snippet in, store commands (and the uninstall
    // fold, a store operation) out.
    fireEvent.click(screen.getByRole('button', { name: 'Code clients' }));
    expect(await screen.findByText(/NODE_EXTRA_CA_CERTS/)).toBeTruthy();
    expect(screen.queryByText(/certutil/)).toBeNull();
  });

  it('decorates with shell prompts but never copies them into the payload', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([]));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Setup Wizard' }));

    const glyphs = await screen.findAllByTitle('Copy');
    for (const g of glyphs) fireEvent.click(g);

    // The `PS>` / `$` glyphs mark typed commands on screen; the clipboard
    // must receive the command ALONE — pasting a prompt glyph into a real
    // shell is a syntax error waiting for the operator's first paste.
    for (const [text] of copyToClipboard.mock.calls as [string][]) {
      expect(text.startsWith('PS>')).toBe(false);
      expect(text.startsWith('$ ')).toBe(false);
    }

    // The verify step splits its platform-mixed block in two: each half is
    // its own copyable command, prompts per platform.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Verify & Test')).toBeTruthy();
    copyToClipboard.mockClear();
    const verifyGlyphs = await screen.findAllByTitle('Copy');
    expect(verifyGlyphs.length).toBe(2);
    for (const g of verifyGlyphs) fireEvent.click(g);

    const verifyCopied = copyToClipboard.mock.calls.map(c => c[0] as string);
    expect(verifyCopied.filter(text => text.includes('curl')).length).toBe(2);
    for (const text of verifyCopied) {
      expect(text.startsWith('PS>')).toBe(false);
      expect(text.startsWith('$ ')).toBe(false);
    }
  });

  it('renders verify commands as OS-tagged rows and copies pure commands', async () => {
    resolveForwardProxyRules.mockImplementation(resolveWith([]));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Setup Wizard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Verify & Test')).toBeTruthy();

    // Platform attribution is a badge (same row shape as the CA trust step),
    // and the Windows rationale survives as prose OUTSIDE the command well.
    expect(screen.getAllByText('macOS / Linux').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Windows').length).toBeGreaterThan(0);
    expect(await screen.findByText(/local CA carries no revocation info/)).toBeTruthy();

    copyToClipboard.mockClear();
    const glyphs = await screen.findAllByTitle('Copy');
    expect(glyphs.length).toBe(2);
    for (const g of glyphs) fireEvent.click(g);

    // The `#` comment used to ride along in the payload; it is now hint
    // prose, so every copied line is a command that can be pasted as-is.
    const copied = copyToClipboard.mock.calls.map(c => c[0] as string);
    expect(copied).toHaveLength(2);
    for (const text of copied) {
      expect(text.startsWith('curl')).toBe(true);
      expect(text.startsWith('#')).toBe(false);
      expect(text.includes('\n')).toBe(false);
    }
  });

  it('never offers to copy the loading placeholder', async () => {
    getProxyCaMeta.mockReset().mockResolvedValue(undefined); // meta never arrives → step stays on Loading…
    resolveForwardProxyRules.mockImplementation(resolveWith([]));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Setup Wizard' }));

    // A glyph over "Loading…" would copy a dead string; the well must stay a
    // plain pre until the real CA path is in hand.
    const copiedBeforeClick = copyToClipboard.mock.calls.length;
    expect(copiedBeforeClick).toBe(0);
    expect(screen.queryByTitle('Copy')).toBeNull();
  });
});

describe('ProxyAccessPage — OS proxy recovery survives a disabled forward proxy', () => {
  beforeEach(() => {
    getConfig.mockReset().mockResolvedValue({ forwardProxy: { ...CONFIG.forwardProxy, enabled: false } });
    resolveForwardProxyRules.mockReset().mockImplementation(resolveWith([]));
    getProxyCaMeta.mockReset().mockResolvedValue(undefined);
    getSystemProxy.mockReset().mockResolvedValue({ state: 'on', proxyEnabled: false, supported: true, caPath: '' });
    disableSystemProxy.mockReset().mockResolvedValue({ state: 'off', proxyEnabled: false, supported: true, caPath: '' });
    copyToClipboard.mockReset();
  });

  it('offers a direct restore on the default config tab', async () => {
    renderPage();

    // Recovery must not depend on finding the wizard's client-routing sub-route.
    fireEvent.click(await screen.findByRole('button', { name: 'Restore now' }));
    await waitFor(() => expect(disableSystemProxy).toHaveBeenCalledTimes(1));
  });

  it('keeps the wizard restore panel read-only when it has no steps', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Setup Wizard' }));
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
    // Pointing the OS at a port nobody listens on must never be one click away.
    expect(screen.queryByRole('button', { name: 'Set System Proxy' })).toBeNull();
  });
});
