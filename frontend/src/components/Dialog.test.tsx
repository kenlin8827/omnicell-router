import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from './Dialog';

/**
 * `closeDisabled` is documented as "disable every dismissal path (×, Escape, backdrop)". The prop
 * once gated only the × button, so a caller blocking it during a request still lost the dialog to
 * an Escape press — the exact half-state the flag exists to prevent.
 */
function renderDialog(props: { closeDisabled?: boolean; backdropClose?: boolean } = {}) {
  const onClose = vi.fn();
  render(
    <Dialog title="Install" closeLabel="Close" onClose={onClose} {...props}>
      <p>body</p>
    </Dialog>
  );
  return { onClose };
}

describe('Dialog dismissal paths', () => {
  it('closes on Escape and on a backdrop press+release by default', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = document.querySelector('[data-ocr-dialog]') as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('blocks the × button, Escape and the backdrop while closeDisabled is set', () => {
    const { onClose } = renderDialog({ closeDisabled: true });

    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect((closeButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(closeButton);

    fireEvent.keyDown(window, { key: 'Escape' });

    const overlay = document.querySelector('[data-ocr-dialog]') as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps backdropClose=false as the narrower opt-out', () => {
    const { onClose } = renderDialog({ backdropClose: false });
    fireEvent.keyDown(window, { key: 'Escape' });
    const overlay = document.querySelector('[data-ocr-dialog]') as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).not.toHaveBeenCalled();
    // The × stays live: this flag removes only the accidental paths.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
