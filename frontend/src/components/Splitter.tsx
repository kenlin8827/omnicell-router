import React, { useCallback, useRef, useState } from 'react';

/**
 * Vertical split-panel splitter, two pieces:
 *
 *   - `useSplitterWidth` — width state + drag behaviour + (opt-in)
 *     localStorage persistence, clamped to [min, max] on both load and
 *     drag. Pages keep their own flex layout and bind `width` to the
 *     pane's style.
 *   - `VSplitter` — the grab strip: 5px column, col-resize cursor,
 *     accent highlight on hover/drag, double-click resets.
 *
 * Deliberately minimal: horizontal splits, keyboard nudging and nested
 * panes are out until a second consumer needs them.
 */
export interface SplitterWidthOptions {
  /** localStorage key; omit for session-only (unpersisted) width. */
  storageKey?: string;
  initial: number;
  min: number;
  max: number;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const useSplitterWidth = ({ storageKey, initial, min, max }: SplitterWidthOptions) => {
  const [width, setWidth] = useState<number>(() => {
    if (!storageKey) return initial;
    const v = Number(localStorage.getItem(storageKey));
    return Number.isFinite(v) && v >= min && v <= max ? v : initial;
  });
  const [hot, setHot] = useState(false); // pointer over the strip, or dragging
  const drag = useRef<{ startX: number; startW: number; latest: number } | null>(null);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: width, latest: width };
      setHot(true);
      // Keep the col-resize cursor and stop text selection while the
      // pointer races across the page mid-drag.
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        if (!drag.current) return;
        const w = clamp(drag.current.startW + ev.clientX - drag.current.startX, min, max);
        drag.current.latest = w;
        setWidth(w);
      };
      const onUp = () => {
        if (drag.current && storageKey) localStorage.setItem(storageKey, String(drag.current.latest));
        drag.current = null;
        setHot(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, min, max, storageKey]
  );

  const reset = useCallback(() => {
    if (storageKey) localStorage.removeItem(storageKey);
    setWidth(initial);
  }, [storageKey, initial]);

  return { width, hot, onResizeStart, reset, setHot };
};

export const VSplitter: React.FC<{
  hot: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
  onHotChange: (hot: boolean) => void;
  onReset: () => void;
}> = ({ hot, onResizeStart, onHotChange, onReset }) => (
  <div
    role="separator"
    aria-orientation="vertical"
    onMouseDown={onResizeStart}
    onMouseEnter={() => onHotChange(true)}
    onMouseLeave={() => onHotChange(false)}
    onDoubleClick={onReset}
    style={{
      width: 5,
      flexShrink: 0,
      cursor: 'col-resize',
      background: hot ? 'var(--accent)' : 'transparent',
      opacity: hot ? 0.55 : 1,
      transition: 'background 0.12s ease',
    }}
  />
);
