import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The Failures page has two behaviours the ledger alone cannot express, and
 * both are load-bearing for reading a row:
 *   1. the coalesced `×N` count must render INSIDE the time column (it used to
 *      spill over the Role badge on dated rows),
 *   2. the row opens a read-only detail drawer showing the FULL error message —
 *      exactly what the two-line table cell has to truncate — and the row's own
 *      action buttons must not double as the opener.
 */
const getFailureEvents = vi.fn();
const deleteFailureEvent = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    getFailureEvents: (...args: unknown[]) => getFailureEvents(...args),
    deleteFailureEvent: (...args: unknown[]) => deleteFailureEvent(...args),
    clearFailureEvents: vi.fn(),
  },
}));

import { FailuresPage } from './FailuresPage';
import { I18nProvider } from '../i18n/I18nContext';
import { ToastProvider } from '../components/ToastProvider';
import { ConfirmProvider } from '../components/ConfirmProvider';

// jsdom ships no ResizeObserver; ScrollTable re-measures column widths on body
// resize, which the page's table now relies on.
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

// Longer than the cell's two clamped lines: the drawer is the only place the
// whole text is readable, so the assertions below must not be satisfiable by a
// truncated cell.
const LONG_MESSAGE =
  'upstream 429: {"error":{"type":"rate_limit_error","message":"You have exceeded the requests-per-minute quota for this key; retry after the window resets."}}';

const EVENT = {
  id: 'ev-1',
  ts: Date.UTC(2026, 0, 2, 3, 4, 5),
  lastTs: Date.UTC(2026, 0, 2, 3, 4, 9),
  count: 8,
  model: 'openai/gpt-5',
  provider: 'openai',
  keyHashPrefix: 'abc123def456',
  errorClass: 'RATE_LIMITED' as const,
  status: 429,
  message: LONG_MESSAGE,
  role: 'serving' as const,
  sessionId: 'sess-abc',
};

/** The model id appears twice (aggregation card + table row) — the row cell is
 *  the one that lives inside a <td>. */
async function modelCell(): Promise<HTMLElement> {
  const hits = await screen.findAllByText('openai/gpt-5');
  const cell = hits.find((el) => el.closest('td'));
  if (!cell) throw new Error('model cell not found');
  return cell;
}

function renderPage() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <FailuresPage />
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

describe('Failures page — row reading', () => {
  beforeEach(() => {
    localStorage.setItem('ocr_lang', 'en');
    getFailureEvents.mockReset();
    deleteFailureEvent.mockReset();
    getFailureEvents.mockResolvedValue({ events: [EVENT] });
    deleteFailureEvent.mockResolvedValue({ removed: 1 });
  });

  it('renders the coalesced ×N inside the time column, next to the stamp', async () => {
    renderPage();
    const count = await screen.findByText('×8');
    // Same cell as the time stamp, and both inside one flex line: the count is
    // a sibling of the stamp, never painted over the neighbouring badge.
    const line = count.parentElement as HTMLElement;
    expect(line.textContent).toContain(count.textContent!);
    expect(line.querySelectorAll('span').length).toBe(2);
    // The Role badge owns its own cell — nothing from the time cell bled into it.
    const badge = screen.getAllByText('Serving').find((el) => el.closest('td'))!;
    const roleCell = badge.closest('td') as HTMLElement;
    expect(roleCell.textContent).toBe('Serving');
  });

  it('opens the detail drawer with the full message and every ledger field', async () => {
    renderPage();
    fireEvent.click(await modelCell());

    const drawer = await waitFor(() => {
      const el = document.querySelector('[data-ocr-drawer]');
      if (!el) throw new Error('drawer not open');
      return el as HTMLElement;
    });
    // Full text, untruncated (the table cell clamps to two lines).
    expect(drawer.textContent).toContain(LONG_MESSAGE);
    // The heading names the record (its handle); the subtitle names the PAIR
    // as '<provider>/<model> <credential>' — no dot separators.
    expect(drawer.querySelector('h3')?.textContent).toBe('Event details - ev-1');
    expect(drawer.textContent).toContain('openai/gpt-5 #abc123def456');
    // Pair identity + the fields the table has no column for.
    expect(drawer.textContent).toContain('×8');
    expect(drawer.textContent).toContain('sess-abc');
    expect(drawer.textContent).toContain('429');
    // Main info is a descriptions TABLE: one label cell per field, and the
    // message is a row of that same table rather than a detached box.
    const descTable = drawer.querySelector('table.desc-table') as HTMLTableElement;
    expect(descTable).not.toBeNull();
    const labels = Array.from(descTable.querySelectorAll('td.desc-label')).map((td) =>
      td.textContent?.trim().toLowerCase(),
    );
    expect(labels).toEqual(expect.arrayContaining(['role', 'cause', 'status', 'provider', 'session']));
    expect(descTable.textContent).toContain(LONG_MESSAGE);
  });

  it('the pinned action cell opens the drawer without firing delete', async () => {
    renderPage();
    const row = (await modelCell()).closest('tr') as HTMLElement;
    const buttons = row.querySelectorAll('button');
    // view / copy / delete, in that order, inside the one pinned cell.
    expect(buttons.length).toBe(3);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(document.querySelector('[data-ocr-drawer]')).not.toBeNull());
    expect(deleteFailureEvent).not.toHaveBeenCalled();

    // The delete button is last and must not double as the drawer opener.
    fireEvent.click(buttons[2]!);
    await waitFor(() => expect(deleteFailureEvent).toHaveBeenCalledWith('ev-1'));
  });
});
