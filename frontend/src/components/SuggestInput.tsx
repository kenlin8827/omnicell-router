import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import {
  DROPDOWN_PANEL_MIN_WIDTH,
  DROPDOWN_PANEL_Z,
  dropdownOptionStyle,
  dropdownSurfaceStyle,
  positionDropdown,
  type DropdownPosition,
} from './dropdown';

/** Suggestion lists are short (a scan captures literals, not a catalogue) — keep the panel compact. */
const PANEL_MAX_HEIGHT = 240;

export type SuggestInputProps = {
  value: string;
  onChange: (value: string) => void;
  /** Hint values, never a closed enum: the input always accepts text outside this list. */
  suggestions: string[];
  placeholder?: string;
  title?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  style?: React.CSSProperties;
  'aria-label'?: string;
};

/**
 * Editable combobox: the input IS the value (free text), and `suggestions` open a themed
 * dropdown of what a scan recognized. A native <datalist> renders an unthemed OS popup, so
 * this reuses the Combobox panel chrome (shared via `dropdown.ts`) while keeping typing direct.
 */
export const SuggestInput: React.FC<SuggestInputProps> = ({
  value,
  onChange,
  suggestions,
  placeholder,
  title,
  inputMode,
  style,
  ...rest
}) => {
  const [open, setOpen] = useState(false);
  /** null = show every suggestion (opened by click/arrow); a string = the typed query filters. */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<DropdownPosition | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return suggestions;
    return suggestions.filter((s) => s.toLowerCase().includes(q));
  }, [suggestions, query]);
  const panelVisible = open && filtered.length > 0;

  const position = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    setPos(positionDropdown(el, DROPDOWN_PANEL_MIN_WIDTH, PANEL_MAX_HEIGHT));
  }, []);

  const openPanel = useCallback(() => {
    if (suggestions.length === 0) return;
    position();
    setQuery(null);
    setActive(Math.max(0, suggestions.findIndex((s) => s === value)));
    setOpen(true);
  }, [position, suggestions, value]);

  const pick = (s: string) => {
    onChange(s);
    setQuery(null);
    setOpen(false);
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onMove = () => position();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, position]);

  // Close on pointerdown outside the input and the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || inputRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keep the active option visible in the scrolling list.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (filtered.length === 0) return;
      e.preventDefault();
      if (!open) {
        openPanel();
        return;
      }
      setActive((i) =>
        e.key === 'ArrowDown' ? (i + 1) % filtered.length : (i - 1 + filtered.length) % filtered.length
      );
      return;
    }
    if (e.key === 'Enter') {
      if (!panelVisible || !filtered[active]) return;
      e.preventDefault();
      pick(filtered[active]!);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Close the panel without letting a surrounding dialog consume the same Escape.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <>
      <input
        {...rest}
        ref={inputRef}
        className="input"
        type="text"
        autoComplete="off"
        role="combobox"
        aria-expanded={panelVisible}
        aria-controls={panelVisible ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={panelVisible && filtered[active] !== undefined ? `${listId}-${active}` : undefined}
        value={value}
        title={title}
        placeholder={placeholder}
        inputMode={inputMode}
        style={style}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setActive(0);
          if (!open) {
            position();
            setOpen(suggestions.length > 0);
          }
        }}
        onClick={() => {
          if (!open) openPanel();
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && (panelRef.current?.contains(next) || inputRef.current?.contains(next))) return;
          setOpen(false);
        }}
      />

      {panelVisible &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            data-suggest-panel=""
            // Keep focus in the input so the click lands before any blur-driven close.
            onMouseDown={(e) => e.preventDefault()}
            style={{
              ...dropdownSurfaceStyle,
              position: 'fixed',
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              zIndex: DROPDOWN_PANEL_Z,
              display: 'flex',
              flexDirection: 'column',
              maxHeight: PANEL_MAX_HEIGHT,
            }}
          >
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              {filtered.map((s, i) => (
                <div
                  key={s}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={s === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(s)}
                  style={{
                    ...dropdownOptionStyle,
                    background: i === active ? 'var(--accent-bg)' : 'transparent',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s}
                  </span>
                  {s === value && <Check size={12} color="var(--accent)" style={{ flexShrink: 0 }} />}
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
