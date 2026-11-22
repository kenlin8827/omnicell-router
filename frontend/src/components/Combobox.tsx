import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import {
  DROPDOWN_PANEL_MAX_HEIGHT,
  DROPDOWN_PANEL_MIN_WIDTH,
  DROPDOWN_PANEL_Z,
  dropdownOptionStyle,
  dropdownSurfaceStyle,
  positionDropdown,
  type DropdownPosition,
} from './dropdown';
export interface ComboboxOption {
  value: string;
  label: string;
  /** Right-aligned auxiliary text (e.g. model count, "not connected" marker). */
  meta?: string;
  /** Tiny outline chip at the far right, after `meta` — the row's kind tag
   *  (e.g. model-ref kind). Pair with `badgeColor`. */
  badge?: string;
  /** CSS color for the `badge` chip (text + derived border); defaults to dim text. */
  badgeColor?: string;
  /** Leading color dot (e.g. theme preview swatch) — rendered in trigger and panel. */
  swatch?: string;
  /** Leading glyph (brand mark, host icon) — rendered in trigger and panel, before the label. */
  icon?: React.ReactNode;
}

/** 10px color dot for `swatch` options — a real preview beats an emoji label. */
const SwatchDot: React.FC<{ color: string }> = ({ color }) => (
  <span
    aria-hidden
    style={{
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: color,
      border: '1px solid rgba(128,128,128,0.35)',
      flexShrink: 0,
    }}
  />
);

type ComboboxBaseProps = {
  options: ComboboxOption[];
  placeholder?: string;
  style?: React.CSSProperties;
  /** Show a clear (×) affordance when a non-empty value is selected; clearing calls onChange(''). */
  clearable?: boolean;
  /**
   * Minimum panel width — use for long labels (e.g. model ids) so options are
   * readable even when the trigger is narrow; clamped to the viewport.
   */
  panelMinWidth?: number;
  /**
   * Always render the filter input, even when options.length ≤ FILTER_THRESHOLD.
   * Use sparingly — for pickers where the user expects to search regardless of
   * the option count (e.g. Quick Connect key picker).
   */
  forceFilter?: boolean;
  /** Non-interactive trigger (e.g. a slot owned by another control). */
  disabled?: boolean;
  /** Validation error state — red border on the trigger, cleared by the caller. */
  invalid?: boolean;
  /** Outward handle to the trigger button — form validation scrolls to and
   *  focuses the refused field (ref into a `<button>`, not into the component). */
  triggerRef?: (el: HTMLButtonElement | null) => void;
  /**
   * Chrome level. `default` = the bordered field look (`.input`). `ghost` = no border/background
   * until hover or focus — for dense toolbars and the console header, where a row of bordered
   * boxes would read as a form instead of "current value, click to change".
   */
  variant?: 'default' | 'ghost';
  /**
   * Suppress the meta text in the trigger button. The panel still shows meta
   * inline on options (unless `hoverMetaOnly`).
   */
  hideMetaInTrigger?: boolean;
  /**
   * Never render `meta` inline — not in the trigger, not in the panel rows.
   * Meta still drives the per-option hover bubble (`data-tip`). For long
   * sentence descriptions that would truncate into noise (e.g. the
   * forward-proxy ingress rows); short tags like member counts should stay
   * inline and NOT set this.
   */
  hoverMetaOnly?: boolean;
};

/**
 * Single-select (default): value is one option value, picking closes the panel.
 * Multi-select (`multiple`): value is the selected array, picking TOGGLES the
 * option and the panel stays open; the trigger shows the selection count and
 * `clearable` × empties the whole selection.
 */
export type ComboboxProps = ComboboxBaseProps &
  (
    | { multiple?: false; value: string; onChange: (value: string) => void }
    | { multiple: true; value: string[]; onChange: (value: string[]) => void }
  );

/**
 * Filterable select (ARIA combobox pattern) — the app-wide dropdown: the native
 * <select> popup cannot be themed (it ignores the custom themes), so ALL selects
 * render through this component for visual consistency.
 * The filter input only appears when it earns its place: options > FILTER_THRESHOLD.
 *
 * Implementation notes (project-specific pitfalls):
 * - Panel is rendered via createPortal(document.body): `.card` has
 *   `backdrop-filter: blur(16px)`, which makes it the containing block for
 *   fixed descendants — a non-portal panel inside a card/dialog would be
 *   positioned relative to the card instead of the viewport.
 * - Panel z-index comes from the shared dropdown chrome (between nested sub-dialogs
 *   at 210 and the global confirm dialog at 300 in the project z-index scale).
 */
/** Show the filter input only above this many options. */
const FILTER_THRESHOLD = 8;

export const Combobox: React.FC<ComboboxProps> = (props) => {
  const { options, placeholder, style, clearable, panelMinWidth, forceFilter, multiple, disabled, variant, hideMetaInTrigger, hoverMetaOnly, invalid, triggerRef: externalTriggerRef } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [pos, setPos] = useState<DropdownPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Dual ref binding: internal keyboard/focus logic + optional outward handle.
  const setTriggerRef = (el: HTMLButtonElement | null) => {
    (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = el;
    externalTriggerRef?.(el);
  };
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Normalized selected set — single-select wraps its scalar into a 0/1-array.
  const values: string[] = multiple
    ? (props.value as string[])
    : (props.value as string)
      ? [props.value as string]
      : [];
  const activeSingleValue = multiple ? '' : (props.value as string);
  const selected = multiple ? undefined : options.find((o) => o.value === activeSingleValue);
  const showFilter = forceFilter || options.length > FILTER_THRESHOLD;

  const emitValues = (next: string[]) => {
    if (multiple) (props as { multiple: true; onChange: (v: string[]) => void }).onChange(next);
    else (props as { multiple?: false; onChange: (v: string) => void }).onChange(next[0] ?? '');
  };

  const filtered = useMemo(() => {
    const base = multiple && selectedOnly ? options.filter((o) => values.includes(o.value)) : options;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.meta || '').toLowerCase().includes(q)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, query, multiple, selectedOnly, values]);

  const position = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setPos(positionDropdown(el, panelMinWidth ?? DROPDOWN_PANEL_MIN_WIDTH, DROPDOWN_PANEL_MAX_HEIGHT));
  }, [panelMinWidth]);

  const openPanel = useCallback(() => {
    position();
    setQuery('');
    setSelectedOnly(false);
    setActive(Math.max(0, options.findIndex((o) => o.value === activeSingleValue)));
    setOpen(true);
  }, [position, options, activeSingleValue]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const pick = (o: ComboboxOption) => {
    if (multiple) {
      // Multi-select: toggle in place, panel STAYS open for batch picking.
      const next = values.includes(o.value)
        ? values.filter((v) => v !== o.value)
        : [...values, o.value];
      emitValues(next);
      return;
    }
    emitValues([o.value]);
    close();
  };

  // Focus the filter input when the panel opens.
  useEffect(() => {
    if (open) filterRef.current?.focus();
  }, [open]);

  // Selection emptied while "selected only" is on → snap back to the full list.
  useEffect(() => {
    if (values.length === 0) setSelectedOnly(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.length]);

  // Keep the panel anchored to the trigger while it is open.
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

  // Close on pointerdown outside trigger + panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keep the active option visible in the scrolling list.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    // Clear shortcut — trigger-only, so Backspace in the filter input never wipes the selection.
    if (clearable && values.length > 0 && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      e.stopPropagation();
      emitValues([]);
      return;
    }
    onPanelKeyDown(e);
  };

  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      // Filter hidden → trigger keeps focus: open on arrow keys (Enter/Space natively click).
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length) setActive((a) => (a + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length) setActive((a) => (a - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered[active]) pick(filtered[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  // No `title` on the trigger: a native tooltip repeating the visible label is
  // pure noise, and on Windows it pops over the list as soon as the mouse moves.
  return (
    <>
      <button
        type="button"
        ref={setTriggerRef}
        className={`${variant === 'ghost' ? 'input input-ghost' : 'input'}${invalid ? ' is-invalid' : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => { if (disabled) return; (open ? close() : openPanel()); }}
        onKeyDown={onTriggerKeyDown}
        style={{ ...style, display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left', opacity: disabled ? 0.5 : 1 }}
      >
        {selected?.swatch && <SwatchDot color={selected.swatch} />}
        {selected?.icon}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: selected || (multiple && values.length > 0) ? 'var(--text-main)' : 'var(--text-dim)',
          }}
        >
          {selected
            ? selected.label
            : multiple
              ? values.length > 0
                ? t('combobox.selectedCount', { n: values.length })
                : (placeholder ?? '')
              : (placeholder ?? '')}
        </span>
        {!hideMetaInTrigger && selected?.meta && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 0 }}>{selected.meta}</span>
        )}
        {clearable && values.length > 0 ? (
          // span (not button): interactive content must not nest inside <button>.
          <span
            role="button"
            tabIndex={-1}
            aria-label={t('common.clear')}
            title={t('common.clear')}
            onClick={(e) => {
              e.stopPropagation();
              emitValues([]);
            }}
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', cursor: 'pointer', color: 'var(--text-dim)' }}
          >
            <X size={13} />
          </span>
        ) : (
          <ChevronDown
            size={13}
            style={{
              flexShrink: 0,
              color: 'var(--text-dim)',
              transform: open ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.15s ease',
            }}
          />
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            data-combobox-panel=""
            onKeyDown={onPanelKeyDown}
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
              maxHeight: DROPDOWN_PANEL_MAX_HEIGHT,
            }}
          >
            {multiple && (
              // Panel header (multi-select only): "selected only" toggle left,
              // explicit close × right — the panel stays open across toggles,
              // so give a clear way to finish.
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6, flexShrink: 0 }}>
                <span>
                  {values.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedOnly((s) => !s);
                        setActive(0);
                      }}
                      className={`btn btn-sm ${selectedOnly ? 'btn-primary' : ''}`}
                      style={{ flexShrink: 0, fontSize: 'var(--text-xs)', padding: '3px 10px' }}
                    >
                      {t('combobox.showSelectedOnly')}
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => close()}
                  aria-label={t('combobox.close')}
                  title={t('combobox.close')}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', padding: 2 }}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {showFilter && (
              <div style={{ position: 'relative', marginBottom: 6, flexShrink: 0 }}>
                <Search
                  size={12}
                  style={{
                    position: 'absolute',
                    left: 9,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-dim)',
                    pointerEvents: 'none',
                  }}
                />
                <input
                  ref={filterRef}
                  className="input"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  style={{ fontSize: 'var(--text-sm)', padding: '6px 10px', paddingLeft: 26 }}
                />
              </div>
            )}
            <div ref={listRef} role="listbox" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map((o, i) => {
                const isActive = i === active;
                const isSelected = values.includes(o.value);
                return (
                  <div
                    key={o.value || `idx-${i}`}
                    role="option"
                    aria-selected={isSelected}
                    data-tip={o.meta}
                    data-tip-side={hoverMetaOnly ? 'right' : undefined}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    style={{
                      ...dropdownOptionStyle,
                      background: isActive ? 'var(--accent-bg)' : 'transparent',
                    }}
                  >
                    {o.swatch && <SwatchDot color={o.swatch} />}
                    {o.icon}
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.label}
                    </span>
                    {!hoverMetaOnly && o.meta && (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', flexShrink: 1, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.meta}</span>
                    )}
                    {o.badge && (
                      <span
                        style={{
                          fontSize: 'var(--text-2xs)',
                          fontWeight: 'var(--font-bold)',
                          textTransform: 'uppercase',
                          letterSpacing: 'var(--tracking-wide)',
                          lineHeight: 'var(--leading-snug)',
                          padding: '0 6px',
                          borderRadius: 999,
                          flexShrink: 0,
                          color: o.badgeColor || 'var(--text-dim)',
                          border: `1px solid color-mix(in srgb, ${o.badgeColor || 'var(--text-dim)'} 45%, transparent)`,
                        }}
                      >
                        {o.badge}
                      </span>
                    )}
                    {isSelected && <Check size={12} color="var(--accent)" style={{ flexShrink: 0 }} />}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ padding: '10px', fontSize: 'var(--text-sm)', color: 'var(--text-dim)', textAlign: 'center' }}>
                  {t('common.noResults')}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
