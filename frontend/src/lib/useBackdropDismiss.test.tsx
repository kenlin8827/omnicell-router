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
