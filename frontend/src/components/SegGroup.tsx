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
  /** `icon` renders before the label; omit `label` for an icon-only switch (the title becomes the
   *  accessible name). */
  options: { value: string; label?: string; title?: string; icon?: React.ReactNode }[];
  size?: 'sm' | 'md' | 'lg';
  embedded?: 'start' | 'end';
  /** Fixed control height (px or CSS length). Use it when the group shares a row with `.btn` and
   *  `.input`, whose padding-derived heights never match the segment metrics. */
  height?: number | string;
}> = ({ value, onChange, options, size = 'md', embedded, height }) => {
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
      ...(height ? { height } : {}),
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
          aria-label={o.label ? undefined : (o.title ?? o.value)}
          onClick={() => onChange(o.value)}
          style={{
            padding: height ? `0 ${m.pad.split(' ')[1]}` : m.pad,
            fontSize: m.font,
            display: 'inline-flex',
            alignItems: 'center',
            height: height ?? undefined,
            gap: 6,
            border: 'none',
            borderRight: i < options.length - 1 ? '1px solid var(--divider)' : 'none',
            background: active ? 'var(--btn-primary-bg)' : 'transparent',
            color: active ? 'var(--btn-primary-text)' : 'var(--text-main)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {o.icon}
          {o.label}
        </button>
      );
    })}
  </div>
  );
};
