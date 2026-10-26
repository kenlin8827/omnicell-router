import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

export type DialogProps = {
  /** Dialog title (usually an i18n string). */
  title: React.ReactNode;
  /** Dim block under the title: hints, the target path, other context. */
  subtitle?: React.ReactNode;
  /** Toolbar actions pinned to the right of the header, before the × button. */
  headerActions?: React.ReactNode;
  /** Scrollable body. */
  children: React.ReactNode;
  /** Footer left slot (destructive / "restore defaults"). */
  footerLeft?: React.ReactNode;
  /** Footer right slot (cancel / save). */
  footerRight?: React.ReactNode;
  /** Runs for the × button, Escape, and a backdrop press+release. */
  onClose: () => void;
  /** i18n label used as the × button's title and aria-label. */
  closeLabel: string;
  /** Allow dismissing via backdrop press+release and Escape (default true).
   * False for dialogs whose accidental dismissal loses data (e.g. a one-time
   * secret reveal) — they close only through their explicit buttons. */
  backdropClose?: boolean;
  /** Card width cap in px. */
  width?: number;
  /** Card max-size overrides (any CSS length). Windowed dialogs default to
      `width` px / content height capped at 88vh; pass e.g.
      `{ width: '90vw', height: '90vh' }` for a proportional expanded layout
      that keeps a viewport margin — `height` there is the card's FIXED
      height (the body scrolls inside it), not just a cap. */
  maxSize?: { width?: string; height?: string };
  /** Blur the backdrop as well as dimming it. */
  blur?: boolean;
  /** Fill the viewport instead of the centered card (fullscreen reading). */
  full?: boolean;
};

/**
 * Shared modal shell for the configuration editors (model editor, OCR source
 * editor). Owns the four interaction rules that used to drift apart per
 * dialog: Escape closes, backdrop closes only on a press+release that both
 * land on the overlay, the page behind is scroll-locked, and the close control
 * is a real button with an accessible label. Callers supply content only —
 * do not re-implement the overlay in a page or dialog component.
 */
export const Dialog: React.FC<DialogProps> = ({
  title,
  subtitle,
  headerActions,
  children,
  footerLeft,
  footerRight,
  onClose,
  closeLabel,
  backdropClose = true,
  width = 660,
  maxSize,
  blur = false,
  full = false,
}) => {
  useBodyScrollLock(true);

  useEffect(() => {
    if (!backdropClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, backdropClose]);

  // Backdrop click closes only when press AND release both happen on the
  // overlay itself — a drag that starts inside the form (text selection)
  // must not dismiss the dialog.
  const mouseDownOnOverlay = useRef(false);

  // Marker for layered-Escape handling: an overlay beneath this dialog (e.g.
  // the capture focus view's own window-level Escape listener) sees the node
  // and yields the key to the topmost dialog.
  return createPortal(
    <div
      data-ocr-dialog=""
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'var(--scrim)',
        backdropFilter: blur ? 'blur(8px)' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: full ? 0 : '16px',
      }}
      onMouseDown={backdropClose ? (e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; } : undefined}
      onMouseUp={backdropClose ? (e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); } : undefined}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: full ? 'none' : (maxSize?.width ?? width),
          maxHeight: full ? 'none' : (maxSize?.height ?? '88vh'),
          height: full ? '100%' : (maxSize?.height ?? undefined),
          borderRadius: full ? 0 : undefined,
          padding: '20px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          overflow: 'hidden',
          animation: 'ocr-pop-in 0.18s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-main)' }}>{title}</h3>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            {headerActions}
            <button
              type="button"
              className="btn btn-sm"
              style={{ display: 'flex', alignItems: 'center', height: 24, padding: '0 6px' }}
              onClick={onClose}
              title={closeLabel}
              aria-label={closeLabel}
            >
              <X size={13} />
            </button>
          </div>
        </div>
        {subtitle ? (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {subtitle}
          </div>
        ) : null}
        {/* flex:1 so a `full` dialog hands its remaining height to the body —
            without it the body stays content-sized and a child asking for
            `flex: 1` has nothing to fill. In windowed mode the card is auto-
            height, so there is no free space and the rule is a no-op. */}
        {/* `scrollbar-gutter: stable` reserves the scrollbar rail for EVERY dialog. Without it a
            body that sits near the height limit oscillates: the scrollbar appears → the content box
            narrows by the rail width → `max-width: 100%` images shrink with it → the body drops back
            under the limit → the scrollbar disappears → the box widens again. The rail is always
            reserved, so the loop cannot start (and text never shifts by 6 px when a dialog grows). */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            paddingRight: 2,
            scrollbarGutter: 'stable',
          }}
        >
          {children}
        </div>
        {footerLeft || footerRight ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 10, borderTop: '1px solid var(--divider)' }}>
            {footerLeft ? <div style={{ marginRight: 'auto' }}>{footerLeft}</div> : null}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>{footerRight}</div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};