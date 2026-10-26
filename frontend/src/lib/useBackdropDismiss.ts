import { useRef } from 'react';
import type { MouseEventHandler } from 'react';

/**
 * Shared backdrop press+release guard for full-screen scrim overlays.
 *
 * A browser `click` fires on the nearest common ancestor of the mousedown and
 * mouseup targets, so "press inside the card, drag out, release" lands a click
 * on the scrim — a plain `onClick` backdrop therefore dismisses on drag. This
 * hook only arms dismissal when mousedown AND mouseup both land on the overlay
 * itself. `<Dialog>` embeds the same rule; use this for overlays that don't go
 * through it.
 */
export function useBackdropDismiss(onDismiss: () => void): {
  onMouseDown: MouseEventHandler<HTMLDivElement>;
  onMouseUp: MouseEventHandler<HTMLDivElement>;
} {
  const armed = useRef(false);
  return {
    onMouseDown: (e) => { armed.current = e.target === e.currentTarget; },
    onMouseUp: (e) => { if (armed.current && e.target === e.currentTarget) onDismiss(); },
  };
}
