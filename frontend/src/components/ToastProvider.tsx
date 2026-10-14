import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  leaving?: boolean;
}

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TYPE_STYLE: Record<ToastType, { color: string; bg: string; Icon: typeof Info }> = {
  success: { color: 'var(--accent-emerald)', bg: 'color-mix(in srgb, var(--accent-emerald) 15%, transparent)', Icon: CheckCircle },
  error: { color: 'var(--accent-rose)', bg: 'color-mix(in srgb, var(--accent-rose) 15%, transparent)', Icon: AlertTriangle },
  info: { color: 'var(--accent)', bg: 'var(--accent-bg)', Icon: Info },
};

const TOAST_MS = 3500;
const LEAVE_MS = 180;
const MAX_STACK = 4;

/**
 * Global toast notifications replacing native `alert()`.
 * Mount <ToastProvider> once near the app root, then anywhere below it:
 *   const toast = useToast();
 *   toast.success('Saved'); toast.error('Failed: ' + err.message);
 */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setToasts((cur) => cur.filter((t) => t.id !== id));
    }, LEAVE_MS);
  }, []);

  const push = useCallback(
    (type: ToastType) => (message: string) => {
      const id = nextId.current++;
      setToasts((cur) => [...cur, { id, type, message }].slice(-MAX_STACK));
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: push('success'),
      error: push('error'),
      info: push('info'),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          // Topmost layer — above the global confirm dialog (300)
          zIndex: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
          maxWidth: 'min(380px, calc(100vw - 32px))',
        }}
      >
        {toasts.map((t) => {
          const s = TYPE_STYLE[t.type];
          const Icon = s.Icon;
          return (
            <div
              key={t.id}
              onClick={() => dismiss(t.id)}
              title="Dismiss"
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '11px 14px',
                borderRadius: 10,
                background: 'var(--card-bg)',
                backdropFilter: 'blur(16px)',
                border: '1px solid var(--card-border)',
                boxShadow: '0 10px 28px rgba(0,0,0,0.35)',
                fontSize: 13,
                color: 'var(--text-main)',
                lineHeight: 1.5,
                wordBreak: 'break-word',
                animation: t.leaving ? 'ocr-toast-out 0.18s ease forwards' : 'ocr-toast-in 0.2s ease',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: s.bg,
                  color: s.color,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={14} />
              </span>
              <span style={{ flex: 1 }}>{t.message}</span>
              <X size={13} style={{ flexShrink: 0, color: 'var(--text-dim)', marginTop: 3 }} />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastApi => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
};
