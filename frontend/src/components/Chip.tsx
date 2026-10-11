import React from 'react';
import { EFFORT_LADDER, EFFORT_I18N_KEY } from '../lib/effort';
import { MODALITY_OPTIONS, modalityLabel } from '../lib/modality';
import { useI18n } from '../i18n/I18nContext';

export type ChipProps = {
  /** Chip content — a short wire value (`high`) or an i18n label, optionally with a leading icon. */
  label: React.ReactNode;
  /** Selected state; rendered as `aria-pressed` so assistive tech announces it. */
  pressed: boolean;
  onToggle: () => void;
  /** Native tooltip, e.g. the localized hint behind a wire value. */
  title?: string;
  /** Accent used in the pressed state; `amber` for warning-style filters (locked-only). */
  tone?: 'accent' | 'amber';
  style?: React.CSSProperties;
};

/**
 * Toggle chip — the app-wide multi-select control for short option rows
 * (thinking-effort levels, filter pills). A real <button>, so it is
 * keyboard-focusable and exposes `aria-pressed`; every visual lives in the
 * `.chip` CSS class (styles/index.css) so all themes apply at once. Never
 * restyle chips inline — that is how they regressed into unclickable text.
 */
export const Chip: React.FC<ChipProps> = ({ label, pressed, onToggle, title, tone = 'accent', style }) => (
  <button
    type="button"
    className={`chip${tone === 'amber' ? ' chip--amber' : ''}`}
    aria-pressed={pressed}
    title={title}
    onClick={onToggle}
    style={style}
  >
    {label}
  </button>
);

export type EffortChipsProps = {
  /** Selected levels; treated as a subset of `EFFORT_LADDER`. */
  value: string[];
  /** Receives the whole new array — the caller decides how to persist it. */
  onChange: (next: string[]) => void;
  style?: React.CSSProperties;
};

/**
 * The 6-level thinking-effort ladder as a Chip row. Reads the ladder from
 * `lib/effort` (single source of truth, mirrored from the backend
 * `EFFORT_LADDER`) and labels each chip `wire — localized` in its tooltip,
 * so every model editor renders the identical control.
 */
export const EffortChips: React.FC<EffortChipsProps> = ({ value, onChange, style }) => {
  const { t } = useI18n();
  return (
    <div className="chip-row" style={style}>
      {EFFORT_LADDER.map((lvl) => {
        const on = value.includes(lvl);
        return (
          <Chip
            key={lvl}
            label={lvl}
            pressed={on}
            title={`${lvl} — ${t(`op.${EFFORT_I18N_KEY[lvl]}`)}`}
            onToggle={() => onChange(on ? value.filter((x) => x !== lvl) : [...value, lvl])}
          />
        );
      })}
    </div>
  );
};

export type ModalityChipsProps = {
  /** Selected modalities; treated as a subset of `MODALITY_OPTIONS`. */
  value: string[];
  onChange: (next: string[]) => void;
  style?: React.CSSProperties;
};

/**
 * The shared modality vocabulary (lib/modality) as a chip row. Chips, not
 * native checkboxes: the glyph-sized checkbox is a ~13px hit target that does
 * not inherit the theme, which made these rows the weakest link in both
 * editors.
 */
export const ModalityChips: React.FC<ModalityChipsProps> = ({ value, onChange, style }) => {
  const { t } = useI18n();
  return (
    <div className="chip-row" style={style}>
      {MODALITY_OPTIONS.map((m) => {
        const on = value.includes(m);
        return (
          <Chip
            key={m}
            label={modalityLabel(t, m)}
            pressed={on}
            title={m}
            onToggle={() => onChange(on ? value.filter((x) => x !== m) : [...value, m])}
          />
        );
      })}
    </div>
  );
};
