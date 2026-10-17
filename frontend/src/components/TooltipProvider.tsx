import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Singleton themed tooltip for the whole app, driven by `[data-tip]`
 * attributes — the styled replacement for native `title` hints (those appear
 * with a long OS delay, cannot be themed, and get clipped by card overflow).
 * Mount <TooltipProvider> once near the app root, then on any element:
 *
 *   <button data-tip={t('some.hint')}>…</button>
 *
 * Delegation model: document-level mouseover/focusin picks the closest
 * `[data-tip]` ancestor; the bubble portals to <body> (same pattern as the
 * Combobox panel) so card overflow / backdrop-filter never clip it.
 * Positioning: centered above the anchor when there is headroom, flipped
 * below near the top edge, clamped to the viewport; follows scroll and
 * resize. Hover opens after a short delay (longer on a cold open to suppress
 * pass-over flashing, shorter when browsing tooltips back-to-back); keyboard
 * focus shows immediately.
 */

const BUBBLE_MAX_WIDTH = 320;
const GAP = 8;
const FLIP_HEADROOM = 160;
const SHOW_DELAY_MS = 300; // cold open: wait out accidental pass-overs
const WARM_DELAY_MS = 100; // browsing one tip right after another stays snappy
const WARM_WINDOW_MS = 500; // leaving a tooltip within this window counts as browsing

type TipPos = { left: number; top: number; below: boolean; width: number };

/** Shared bubble visual — used here and by InfoTip so the two never diverge. */
export const TipBubble: React.FC<{
  left: number;
  top: number;
  below: boolean;
  width: number;
  text: string;
}> = ({ left, top, below, width, text }) => (
  <div
    role="tooltip"
    style={{
      position: 'fixed',
      left,
      top,
      transform: below ? undefined : 'translateY(-100%)',
      width,
      zIndex: 230,
      padding: '8px 10px',
      borderRadius: 8,
      background: 'var(--card-bg)',
      border: '1px solid var(--card-border)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      color: 'var(--text-main)',
      fontSize: 12,
      lineHeight: 1.6,
      textAlign: 'left',
      pointerEvents: 'none',
    }}
  >
    {text}
  </div>
);

const place = (el: HTMLElement): TipPos => {
  const r = el.getBoundingClientRect();
  const width = Math.min(BUBBLE_MAX_WIDTH, window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
  const below = r.top < FLIP_HEADROOM;
  return { left, top: below ? r.bottom + GAP : r.top - GAP, below, width };
};

interface OpenTip {
  anchor: HTMLElement;
  text: string;
  pos: TipPos;
}

export const TooltipProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tip, setTip] = useState<OpenTip | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const lastCloseRef = useRef<number>(0);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
    const hide = () => {
      clearTimer();
      if (anchorRef.current) lastCloseRef.current = performance.now();
      anchorRef.current = null;
      setTip(null);
    };
    const open = (el: HTMLElement) => {
      clearTimer();
      anchorRef.current = el;
      setTip({ anchor: el, text: el.getAttribute('data-tip') ?? '', pos: place(el) });
    };
    // Delayed hover open: anchor is set immediately (so child mouseovers
    // don't reschedule), the bubble opens once the delay elapses. Cold opens
    // wait out accidental pass-overs; moving between tooltips back-to-back
    // (within WARM_WINDOW_MS of the last one) uses the short warm delay.
    const show = (el: HTMLElement) => {
      clearTimer();
      anchorRef.current = el;
      const warm = performance.now() - lastCloseRef.current < WARM_WINDOW_MS;
      timerRef.current = window.setTimeout(
        () => {
          timerRef.current = undefined;
          setTip({ anchor: el, text: el.getAttribute('data-tip') ?? '', pos: place(el) });
        },
        warm ? WARM_DELAY_MS : SHOW_DELAY_MS,
      );
    };
    // Resolve the tooltip anchor under an event target: the closest ancestor
    // carrying a non-empty [data-tip] attribute.
    const anchorFrom = (target: EventTarget | null): HTMLElement | null => {
      const el = target instanceof Element ? target.closest('[data-tip]') : null;
      return el instanceof HTMLElement && el.getAttribute('data-tip') ? el : null;
    };

    // mouseover fires on every element entry, so it alone tracks hover
    // transitions: enter an anchor → show (delayed); enter anything else → hide.
    const onOver = (e: MouseEvent) => {
      const el = anchorFrom(e.target);
      if (el) {
        if (el !== anchorRef.current) show(el);
      } else if (anchorRef.current) {
        hide();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = anchorFrom(e.target);
      if (el && el !== anchorRef.current) open(el);
    };
    const onFocusOut = (e: FocusEvent) => {
      const related = e.relatedTarget;
      if (!(related instanceof Node) || !anchorRef.current?.contains(related)) hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    const reposition = () => {
      setTip((t) => {
        if (!t) return t;
        if (!document.contains(t.anchor)) return null; // anchor unmounted (row deleted, dialog closed)
        return { ...t, pos: place(t.anchor) };
      });
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('mousedown', hide);
    document.addEventListener('keydown', onKey);
    document.documentElement.addEventListener('mouseleave', hide);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      clearTimer();
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('mousedown', hide);
      document.removeEventListener('keydown', onKey);
      document.documentElement.removeEventListener('mouseleave', hide);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, []);

  return (
    <>
      {children}
      {tip &&
        createPortal(
          <TipBubble left={tip.pos.left} top={tip.pos.top} below={tip.pos.below} width={tip.pos.width} text={tip.text} />,
          document.body,
        )}
    </>
  );
};
