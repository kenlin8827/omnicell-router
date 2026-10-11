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
  /** Card width cap in px. */
  width?: number;
  /** Blur the backdrop as well as dimming it. */
  blur?: boolean;
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
  width = 660,
  blur = false,
}) => {
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Backdrop click closes only when press AND release both happen on the
  // overlay itself — a drag that starts inside the form (text selection)
  // must not dismiss the dialog.
  const mouseDownOnOverlay = useRef(false);

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: blur ? 'blur(8px)' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: width,
          maxHeight: '88vh',
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
        <div style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '12px', paddingRight: 2 }}>
          {children}
        </div>
        {footerLeft || footerRight ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 10, borderTop: '1px solid var(--card-border)' }}>
            {footerLeft ? <div style={{ marginRight: 'auto' }}>{footerLeft}</div> : null}
            {footerRight}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};