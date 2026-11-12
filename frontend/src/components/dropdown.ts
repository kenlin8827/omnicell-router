import type React from 'react';
import { FONT_MONO } from '../lib/fonts';

/**
 * Shared chrome for the app's dropdown panels (Combobox, SuggestInput).
 * Kept in one place so the themed popup cannot drift between the two.
 *
 * The panel is rendered through a portal: `.card` has `backdrop-filter: blur(16px)`,
 * which makes it the containing block for fixed descendants.
 */
export const DROPDOWN_PANEL_Z = 220;
export const DROPDOWN_PANEL_MAX_HEIGHT = 380;
/** Panel never shrinks below this, even when the trigger is tiny. */
export const DROPDOWN_PANEL_MIN_WIDTH = 200;

export type DropdownPosition = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
};

/** Anchor a fixed panel to a trigger, flipping above it when there is no room below. */
export function positionDropdown(
  trigger: HTMLElement,
  minWidth = DROPDOWN_PANEL_MIN_WIDTH,
  maxHeight = DROPDOWN_PANEL_MAX_HEIGHT
): DropdownPosition {
  const r = trigger.getBoundingClientRect();
  const spaceBelow = window.innerHeight - r.bottom;
  const openUp = spaceBelow < maxHeight && r.top > spaceBelow;
  const width = Math.max(r.width, minWidth);
  // Clamp horizontally: a panel wider than its trigger must not overflow the right edge.
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  return openUp
    ? { left, width, bottom: window.innerHeight - r.top + 4 }
    : { left, width, top: r.bottom + 4 };
}

export const dropdownSurfaceStyle: React.CSSProperties = {
  background: 'var(--card-bg)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  border: '1px solid var(--card-border)',
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
  padding: 6,
  animation: 'ocr-pop-in 0.12s ease',
};

export const dropdownOptionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  borderRadius: 6,
  fontSize: 'var(--text-sm)',
  cursor: 'pointer',
  color: 'var(--text-main)',
  // Mono for model ids, but JetBrains Mono/Consolas have no CJK glyphs — without
  // these fallbacks Chinese labels render in the OS default monospace (SimSun on
  // Windows), which looks unlike the rest of the UI. Same stack as the .input rule.
  fontFamily: FONT_MONO,
};
