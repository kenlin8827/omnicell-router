import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info } from 'lucide-react';
import { TipBubble } from './TooltipProvider';

/**
 * Help icon with a hover / focus / click tooltip, portaled to <body> so cards
 * with overflow or backdrop-filter never clip it (same pattern as the
 * Combobox panel). Replaces native `title`-attribute hints: those appear with
 * a long OS delay and cannot be themed.
 *
 * Positioning: centered above the icon when there is headroom, flipped below
 * near the top edge, clamped to the viewport; follows scroll and resize.
 *
 * variant="warning" swaps the icon for an amber triangle (state warnings,
 * e.g. "client not detected on this machine"); default stays the info glyph.
 */

const BUBBLE_MAX_WIDTH = 320;
const GAP = 8;
const FLIP_HEADROOM = 160;

export const InfoTip: React.FC<{ text: string; variant?: 'info' | 'warning' }> = ({ text, variant = 'info' }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean; width: number } | null>(null);
  const iconRef = useRef<HTMLButtonElement>(null);
  const Icon = variant === 'warning' ? AlertTriangle : Info;

  const place = useCallback(() => {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(BUBBLE_MAX_WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const below = r.top < FLIP_HEADROOM;
    setPos({ left, top: below ? r.bottom + GAP : r.top - GAP, below, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        ref={iconRef}
        className={variant === 'warning' ? 'info-tip info-tip--warning' : 'info-tip'}
        aria-label={text}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Icon size={12} />
      </button>
      {open &&
        pos &&
        createPortal(
          <TipBubble left={pos.left} top={pos.top} below={pos.below} width={pos.width} text={text} />,
          document.body,
        )}
    </>
  );
};
