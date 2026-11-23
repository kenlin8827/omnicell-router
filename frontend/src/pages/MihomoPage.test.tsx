import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Measure all" is a ranking question, so a completed batch promotes the node
 * table to ascending latency order on its own — and only from the neutral
 * state: an operator who already picked descending keeps that order, because
 * the header arrow stays the single source of what order is on screen.
 *
 * A batch is one controller call that settles every row at once, so the table
 * reorders exactly once; the config order it displaces is display-only.
 */
const getConfig = vi.fn();
const getMihomoStatus = vi.fn();
const getMihomoProxies = vi.fn();
const testMihomoDelay = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    getMihomoStatus: (...a: unknown[]) => getMihomoStatus(...a),
    getMihomoProxies: (...a: unknown[]) => getMihomoProxies(...a),
    testMihomoDelay: (...a: unknown[]) => testMihomoDelay(...a),
    getMihomoSubscriptions: vi.fn(async () => ({ subscriptions: [], providers: [] })),
    getMihomoRules: vi.fn(async () => []),
    getMihomoGeo: vi.fn(async () => ({ downloaded: false, files: [] })),
    getMihomoLogs: vi.fn(async () => ({ lines: [] })),
    getSystemProxy: vi.fn(async () => ({ owner: null })),
    getMihomoNodeCatalog: vi.fn(async () => ({ protocols: [], transport: [] })),
    getMihomoNodes: vi.fn(async () => ({ nodes: [] })),
  },
  OcApiError: class extends Error {
    reasonCode?: string;
  },
}));

import { MihomoPage } from './MihomoPage';
import { I18nProvider } from '../i18n/I18nContext';
import { ToastProvider } from '../components/ToastProvider';
import { ConfirmProvider } from '../components/ConfirmProvider';

// jsdom ships no ResizeObserver; ScrollTable measures its columns from the body.
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

const node = (name: string) => ({
  name,
  type: 'Shadowsocks',
  delay: null,
  selected: false,
  manualId: null,
  source: { kind: 'manual', id: name },
});

/** Row order as rendered: the name column of every body row, top to bottom. */
const rowNames = () => Array.from(document.querySelectorAll('tbody tr'), tr => tr.querySelector('td')?.textContent ?? '');

const renderPage = async () => {
  render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <MihomoPage />
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>
  );
  fireEvent.click(await screen.findByRole('button', { name: /Nodes/ }));
  await waitFor(() => expect(rowNames()).toEqual(['A', 'B', 'C']), { timeout: 3000 });
};

describe('mihomo node table latency order', () => {
  beforeEach(() => {
    getConfig.mockResolvedValue({ proxy: { mode: 'mihomo', mihomo: { subscriptions: [] } } });
    getMihomoStatus.mockResolvedValue({ running: true, installed: true, secretConfigured: true });
    getMihomoProxies.mockResolvedValue({
      groups: [{ name: 'GLOBAL', type: 'Selector', now: 'A', all: ['A', 'B', 'C'] }],
      nodes: [node('A'), node('B'), node('C')],
      groupType: 'select',
      group: 'GLOBAL',
    });
    testMihomoDelay.mockResolvedValue({ status: 'ok', delays: { A: 300, B: 100, C: 200 } });
  });

  it('ranks fastest-first after a completed batch', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Measure all/ }));
    await waitFor(() => expect(rowNames()).toEqual(['B', 'C', 'A']), { timeout: 3000 });
  });

  it('keeps an order the operator already chose', async () => {
    await renderPage();

    // Two clicks on the latency head: ascending, then descending.
    fireEvent.click(screen.getByRole('button', { name: /Sort by latency/ }));
    fireEvent.click(screen.getByRole('button', { name: /Sort by latency/ }));

    fireEvent.click(screen.getByRole('button', { name: /Measure all/ }));
    await waitFor(() => expect(rowNames()).toEqual(['A', 'C', 'B']), { timeout: 3000 });
  });
});
