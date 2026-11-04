import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

export type DrawerProps = {
  /** Drawer title (usually an i18n string or rich header node). */
  title: React.ReactNode;
  /** Subtitle context below the title. */
  subtitle?: React.ReactNode;
  /** Header actions pinned to the right before the close button. */
  headerActions?: React.ReactNode;
  /** Scrollable content body. */
  children: React.ReactNode;
  /** Optional bottom footer container. */
  footer?: React.ReactNode;
  /** Close callback. */
  onClose: () => void;
  /** Accessible label for the close button. */
  closeLabel?: string;
  /** Allow dismissing via backdrop press+release and Escape (default true). */
  backdropClose?: boolean;
  /** Drawer width, e.g. 640 or '640px' or 'min(640px, 94vw)'. Defaults to min(680px, 94vw). */
  width?: number | string;
};

/**
 * Shared right-side drawer component for management panels and details lenses.
 * Slides in from the right viewport boundary with scrim overlay, keyboard Escape
 * listener, accessible dismissal, and body scroll locking.
 */
export const Drawer: React.FC<DrawerProps> = ({
  title,
  subtitle,
  headerActions,
  children,
  footer,
  onClose,
  closeLabel = 'Close',
  backdropClose = true,
  width = 'min(680px, 94vw)',
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

  const mouseDownOnOverlay = useRef(false);
  const resolvedWidth = typeof width === 'number' ? `${width}px` : width;

  return createPortal(
    <div
      data-ocr-drawer=""
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 210,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'flex-end',
        animation: 'ocr-fade-in 0.15s ease',
      }}
      onMouseDown={
        backdropClose
          ? (e) => {
              mouseDownOnOverlay.current = e.target === e.currentTarget;
            }
          : undefined
      }
      onMouseUp={
        backdropClose
          ? (e) => {
              if (mouseDownOnOverlay.current && e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: resolvedWidth,
          height: '100vh',
          maxHeight: '100vh',
          borderRadius: 0,
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: 'none',
          display: 'flex',
          flexDirection: 'column',
          animation: 'ocr-slide-in-right 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.28)',
          background: 'var(--card-bg, #1e1e24)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '16px 20px',
            borderBottom: '1px solid var(--divider)',
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3
              style={{
                margin: 0,
                fontSize: '16px',
                fontWeight: 600,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </h3>
            {subtitle && (
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  marginTop: '4px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {subtitle}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {headerActions}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              title={closeLabel}
              aria-label={closeLabel}
              style={{
                padding: '6px',
                lineHeight: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '6px',
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
          }}
        >
          {children}
        </div>

        {/* Optional Footer */}
        {footer && (
          <div
            style={{
              padding: '12px 20px',
              borderTop: '1px solid var(--divider)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '10px',
              flexShrink: 0,
              background: 'var(--card-bg-header, rgba(255, 255, 255, 0.02))',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
