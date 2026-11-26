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
 *  standalone toolbar default, 'lg' is a page-level primary mode switch.
 *  `minWidth` floors short labels (Rules / Direct, Request / Hex): equal-height padding
 *  alone lets a two-character option collapse into a cramped chip next to its
 *  neighbours, so every segment keeps a comfortable hit target instead. */
const SIZES = {
  sm: { pad: '4px 9px', font: 'var(--text-xs)', radius: 6, minWidth: 44 },
  md: { pad: '5px 12px', font: 'var(--text-sm)', radius: 8, minWidth: 64 },
  lg: { pad: '7px 16px', font: 'var(--text-md)', radius: 10, minWidth: 80 },
} as const;

export const SegGroup: React.FC<{
  value: string;
  onChange: (v: string) => void;
  /** `icon` renders before the label; omit `label` for an icon-only switch (the title becomes the
   *  accessible name). `disabled` greys the segment out (e.g. a ctx step above the
   *  planner's ceiling) — the option stays visible but cannot be picked. */
  options: { value: string; label?: string; title?: string; icon?: React.ReactNode; disabled?: boolean }[];
  size?: 'sm' | 'md' | 'lg';
  embedded?: 'start' | 'end';
  /** Fixed control height (px or CSS length). Use it when the group shares a row with `.btn` and
   *  `.input`, whose padding-derived heights never match the segment metrics. */
  height?: number | string;
  /** Overrides the size's own minimum width per option button — use it to widen the hit targets
   *  of very short labels (Request / Hex) beyond the `sm`/`md`/`lg` floor. */
  optionMinWidth?: number;
  /** Let the group AUTO-WRAP when the column is too narrow for one row (long
   *  labels, many options). Each segment then carries its own border with a
   *  -1px overlap, so segments still read JOINED inside a wrapped row instead
   *  of falling apart into floating chips. Implies a block-level group. */
  wrap?: boolean;
}> = ({ value, onChange, options, size = 'md', embedded, height, optionMinWidth, wrap }) => {
  const m = SIZES[size];
  return (
  <div
    role="group"
    style={{
      display: wrap ? 'flex' : 'inline-flex',
      alignItems: 'stretch',
      ...(wrap ? { flexWrap: 'wrap' as const, gap: 6 } : {}),
      /* Hug the segments even when the parent is a column flex box (a `.sub-card`
       * field stack): a stretched group paints a dead full-width track beside the
       * switch, which reads as an empty input rather than a mode selector. A
       * wrapping group claims the row instead — it needs the width to know
       * WHERE to break. */
      width: wrap ? '100%' : 'fit-content',
      /* Wrapped rows paint their own per-segment borders; the container frame
       * (and its clipping) would double-draw them. */
      overflow: wrap ? undefined : 'hidden',
      ...(embedded
        ? {
            border: 'none',
            borderRight: embedded === 'start' ? '1px solid var(--divider)' : 'none',
            borderLeft: embedded === 'end' ? '1px solid var(--divider)' : 'none',
            borderRadius: 0,
            background: 'transparent',
          }
        : wrap
          ? { background: 'transparent' }
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
          /* The current pick never disables itself: greying it out would trap
           * the operator with no way back to another segment. */
          disabled={o.disabled && !active}
          title={o.disabled && !active ? undefined : o.title}
          aria-label={o.label ? undefined : (o.title ?? o.value)}
          onClick={() => onChange(o.value)}
          style={{
            padding: height ? `0 ${m.pad.split(' ')[1]}` : m.pad,
            fontSize: m.font,
            justifyContent: 'center',
            /* The floor applies to labelled options only: an icon-only switch has no
             * text to pad out, and a 64px icon chip reads as a broken empty button. */
            minWidth: optionMinWidth ?? (o.label ? m.minWidth : undefined),
            display: 'inline-flex',
            alignItems: 'center',
            height: height ?? undefined,
            gap: 6,
            /* Wrapped rows: the container draws no frame, so each segment
             * borders itself; the group's 6px gap keeps them apart as a chip
             * row that wraps cleanly. */
            border: wrap ? '1px solid var(--divider)' : 'none',
            ...(wrap ? { borderRadius: m.radius } : { borderRight: i < options.length - 1 ? '1px solid var(--divider)' : 'none' }),
            background: active ? 'var(--btn-primary-bg)' : 'transparent',
            color: active ? 'var(--btn-primary-text)' : 'var(--text-main)',
            cursor: o.disabled ? 'not-allowed' : 'pointer',
            opacity: o.disabled ? 0.4 : 1,
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
