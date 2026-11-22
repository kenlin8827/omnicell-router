import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useBackdropDismiss } from './useBackdropDismiss';

function Probe({ onDismiss }: { onDismiss: () => void }) {
  const handlers = useBackdropDismiss(onDismiss);
  return (
    <div data-testid="overlay" {...handlers}>
      <div data-testid="card">content</div>
    </div>
  );
}

describe('useBackdropDismiss', () => {
  it('dismisses when press AND release both land on the overlay', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);
    const overlay = screen.getByTestId('overlay');
    await user.pointer([
      { keys: '[MouseLeft>]', target: overlay },
      { keys: '[/MouseLeft]', target: overlay },
    ]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT dismiss when the press starts inside the card and releases on the overlay (drag out)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByTestId('card') },
      { keys: '[/MouseLeft]', target: screen.getByTestId('overlay') },
    ]);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does NOT dismiss when the press starts on the overlay and releases inside the card (drag in)', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByTestId('overlay') },
      { keys: '[/MouseLeft]', target: screen.getByTestId('card') },
    ]);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

/** Two stacked overlays (provider dialog + its nested add/edit form), each
 *  with an independent guard. This is the exact shape that regressed when the
 *  nested form used a plain `onClick`: selecting text in a field and letting
 *  go on the scrim dismissed the form. */
function NestedProbe({ onOuter, onInner }: { onOuter: () => void; onInner: () => void }) {
  const outer = useBackdropDismiss(onOuter);
  const inner = useBackdropDismiss(onInner);
  return (
    <div data-testid="outer-overlay" {...outer}>
      <div data-testid="inner-overlay" {...inner}>
        <div data-testid="field">field</div>
      </div>
    </div>
  );
}

describe('useBackdropDismiss — nested overlays', () => {
  it('drag from an inner field out onto the inner scrim closes NEITHER overlay', async () => {
    const user = userEvent.setup();
    const onOuter = vi.fn();
    const onInner = vi.fn();
    render(<NestedProbe onOuter={onOuter} onInner={onInner} />);
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByTestId('field') },
      { keys: '[/MouseLeft]', target: screen.getByTestId('inner-overlay') },
    ]);
    expect(onInner).not.toHaveBeenCalled();
    expect(onOuter).not.toHaveBeenCalled();
  });

  it('a deliberate press+release on the inner scrim closes ONLY the inner overlay', async () => {
    const user = userEvent.setup();
    const onOuter = vi.fn();
    const onInner = vi.fn();
    render(<NestedProbe onOuter={onOuter} onInner={onInner} />);
    const innerOverlay = screen.getByTestId('inner-overlay');
    await user.pointer([
      { keys: '[MouseLeft>]', target: innerOverlay },
      { keys: '[/MouseLeft]', target: innerOverlay },
    ]);
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onOuter).not.toHaveBeenCalled();
  });
});
