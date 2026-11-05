import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, CornerDownLeft, Search, X, type LucideIcon } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

export interface CommandItem {
  to: string;
  label: string;
  group: string;
  icon: LucideIcon;
}

interface CommandPaletteProps {
  open: boolean;
  items: CommandItem[];
  onClose: () => void;
  onSelect: (to: string) => void;
}

/** Keyboard-first navigation across the complete console route catalogue. */
export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, items, onClose, onSelect }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.label} ${item.group} ${item.to}`.toLocaleLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previousFocus.current?.focus();
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector(`[data-command-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const choose = (to: string) => {
    onSelect(to);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => (filtered.length ? (value + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => (filtered.length ? (value - 1 + filtered.length) % filtered.length : 0));
    } else if (event.key === 'Enter' && filtered[active]) {
      event.preventDefault();
      choose(filtered[active].to);
    } else if (event.key === 'Tab') {
      const focusable = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])') ?? []
      ).filter((element) => !element.hasAttribute('disabled'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  return createPortal(
    <div className="command-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={rootRef}
        className="command-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.searchPlaceholder')}
        onKeyDown={onKeyDown}
      >
        <div className="command-input-row">
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('nav.searchPlaceholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? `command-option-${active}` : undefined}
          />
          <kbd>Ctrl K</kbd>
          <button type="button" className="app-icon-button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={17} />
          </button>
        </div>
        <div id="command-results" className="command-results" role="listbox">
          {filtered.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                id={`command-option-${index}`}
                data-command-index={index}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                className="command-option"
                key={item.to}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item.to)}
              >
                <span className="command-option-icon"><Icon size={17} /></span>
                <span className="command-option-copy">
                  <strong>{item.label}</strong>
                  <small>{item.group}</small>
                </span>
                {index === active ? <CornerDownLeft size={15} /> : <ArrowUpRight size={15} />}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="command-empty">
              <Search size={24} />
              <span>{t('common.noResults')}</span>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
