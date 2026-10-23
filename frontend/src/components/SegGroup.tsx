import React from 'react';

/**
 * Joined segmented switch (single-select): one bordered container, shared
 * dividers. Used for view-mode switches and short mutually exclusive filters.
 * `aria-pressed` per button keeps the group keyboard-reachable; labels are
 * always caller-supplied i18n strings.
 *
 * `size`: 'md' (default) is the standalone toolbar size; 'sm' matches `.btn-sm`
 * (4px/9px padding, 11px) for a control that sits INSIDE a labelled form row,
 * where the md block overpowers the 11px field label next to it.
 *
 * `embedded`: the group is one ZONE of a `.input-group` frame — a mode switch
 * sitting on ONE SIDE of the field it governs ('start' before the field,
 * 'end' after it). The frame already draws the outer border, radius and the
 * focus ring, so the group drops its own chrome and keeps only the divider on
 * the side that faces the neighbouring control — two visible frames inside one
 * frame read as two controls.
 */
/** Per-size metrics: 'sm' sits inside a labelled form row, 'md' is the
 *  standalone toolbar default, 'lg' is a page-level primary mode switch. */
const SIZES = {
  sm: { pad: '4px 9px', font: 11, radius: 6 },
  md: { pad: '5px 12px', font: 12, radius: 8 },
  lg: { pad: '7px 16px', font: 13, radius: 10 },
} as const;

export const SegGroup: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; title?: string }[];
  size?: 'sm' | 'md' | 'lg';
  embedded?: 'start' | 'end';
}> = ({ value, onChange, options, size = 'md', embedded }) => {
  const m = SIZES[size];
  return (
  <div
    role="group"
    style={{
      display: 'inline-flex',
      alignItems: 'stretch',
      overflow: 'hidden',
      ...(embedded
        ? {
            border: 'none',
            borderRight: embedded === 'start' ? '1px solid var(--divider)' : 'none',
            borderLeft: embedded === 'end' ? '1px solid var(--divider)' : 'none',
            borderRadius: 0,
            background: 'transparent',
          }
        : {
            border: '1px solid var(--divider)',
            borderRadius: m.radius,
            background: 'var(--btn-bg)',
          }),
    }}
  >
    {options.map((o, i) => {
      const active = value === o.value;
      return (
        <button
          key={o.value || 'all'}
          type="button"
          aria-pressed={active}
          title={o.title}
          onClick={() => onChange(o.value)}
          style={{
            padding: m.pad,
            fontSize: m.font,
            border: 'none',
            borderRight: i < options.length - 1 ? '1px solid var(--divider)' : 'none',
            background: active ? 'var(--btn-primary-bg)' : 'transparent',
            color: active ? 'var(--btn-primary-text)' : 'var(--text-main)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {o.label}
        </button>
      );
    })}
  </div>
  );
};
