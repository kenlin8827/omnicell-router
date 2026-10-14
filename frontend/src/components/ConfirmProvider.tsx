import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Danger actions get a red confirm button and a warning icon. */
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Opt-in: blur the page behind the overlay. Default: dim only, no blur. */
  blur?: boolean;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface ActiveConfirm {
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

/**
 * Global confirmation dialog replacing native `window.confirm`.
 * Mount <ConfirmProvider> once near the app root, then anywhere below it:
 *   const confirmDialog = useConfirm();
 *   if (await confirmDialog({ title: '...', danger: true })) { ... }
 */
export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  const [active, setActive] = useState<ActiveConfirm | null>(null);
  const activeRef = useRef<ActiveConfirm | null>(null);
  useBodyScrollLock(!!active);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      const entry = { options, resolve };
      activeRef.current = entry;
      setActive(entry);
    });
  }, []);

  const close = useCallback((result: boolean) => {
    const entry = activeRef.current;
    if (!entry) return;
    activeRef.current = null;
    entry.resolve(result);
    setActive(null);
  }, []);

  // Esc = cancel, Enter = confirm (no-op when nothing is open)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, close]);

  const o = active?.options;
  const danger = !!o?.danger;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {o && (
        <div
          onClick={() => close(false)}
          style={{
            position: 'fixed',
            inset: 0,
            // Above ALL feature dialogs (page modals 100 / dialogs 200 / nested 210)
            zIndex: 300,
            background: 'var(--scrim)',
            backdropFilter: o?.blur ? 'blur(8px)' : undefined,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            animation: 'ocr-fade-in 0.15s ease',
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 400,
              padding: '22px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              animation: 'ocr-pop-in 0.18s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: danger ? 'color-mix(in srgb, var(--accent-rose) 15%, transparent)' : 'var(--accent-bg)',
                  color: danger ? 'var(--accent-rose)' : 'var(--accent)',
                }}
              >
                {danger ? <AlertTriangle size={18} /> : <HelpCircle size={18} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-main)', lineHeight: 1.45, wordBreak: 'break-word' }}>
                  {o.title}
                </div>
                {o.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {o.description}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn" onClick={() => close(false)}>
                {o.cancelLabel ?? t('common.cancel')}
              </button>
              <button
                className={danger ? 'btn btn-danger' : 'btn btn-primary'}
                autoFocus
                onClick={() => close(true)}
              >
                {o.confirmLabel ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};

export const useConfirm = (): ConfirmFn => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
};
