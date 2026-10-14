import React, { useEffect, useRef, useState } from 'react';
import { Combobox } from './Combobox';
import { useI18n } from '../i18n/I18nContext';

/**
 * Shared duration input — the canonical value is ALWAYS integer milliseconds;
 * the unit dropdown (i18n'd labels) is a typing aid, not part of the value.
 *
 * Editor seed converts to the DISPLAY unit (h tier above 1h, else s) so the
 * number matches the chip; when that tier would need a decimal it falls back
 * to raw ms — integers only, so text × factor round-trips exactly and the
 * input never shows a decimal point. Switching the unit mid-edit only changes
 * the factor for what you type next (the text clears instead of converting).
 * Pretty formatting (e.g. "30s") lives in the display chip either way.
 *
 * Edit-mode exit: pointerdown outside the group (or Enter / Escape). Blur is
 * NOT an exit trigger — clicking the unit dropdown (or its portaled panel,
 * whitelisted via [data-combobox-panel]) must not dismiss the editor before
 * the pick lands. Keystrokes commit live, so exiting needs no final commit.
 */

interface DurationUnit {
  id: string;
  ms: number;
}

/** Descending by magnitude; the LAST entry is the raw canonical unit (ms). */
const UNITS: DurationUnit[] = [
  { id: 'h', ms: 3_600_000 },
  { id: 'min', ms: 60_000 },
  { id: 's', ms: 1_000 },
  { id: 'ms', ms: 1 },
];

/** Editor seed: the DISPLAY unit (h tier above 1h, else s) when it divides the
 *  value evenly, else raw ms — integer text guarantees an exact round-trip. */
const seedState = (ms: number): SegState => {
  const disp = UNITS.find((u) => u.id === (ms >= 3_600_000 ? 'h' : 's')) ?? UNITS[UNITS.length - 1];
  return ms % disp.ms === 0
    ? { unit: disp, text: String(ms / disp.ms) }
    : { unit: UNITS[UNITS.length - 1], text: String(ms) };
};

export interface DurationInputProps {
  /** Canonical duration in integer milliseconds (>= 0). */
  value: number;
  onChange: (ms: number) => void;
  /** Accessible name (AutoField passes `${label} (${keyName})`). */
  ariaLabel?: string;
  /** Tooltip — the param's own yaml key on the breaker rules page. */
  title?: string;
  /** Focus + select the number on mount (edit-mode entry). */
  autoFocus?: boolean;
  /** Edit-mode exit: fires on outside pointerdown, Enter, or Escape. */
  onDone?: () => void;
}

interface SegState {
  unit: DurationUnit;
  text: string;
}

export const DurationInput: React.FC<DurationInputProps> = ({ value, onChange, ariaLabel, title, autoFocus, onDone }) => {
  const { t } = useI18n();
  const groupRef = useRef<HTMLSpanElement>(null);
  const [st, setSt] = useState<SegState>(() => seedState(value));

  // External value change (draft reset): re-seed to the display-unit number.
  useEffect(() => {
    setSt((prev) => {
      const n = Number(prev.text);
      if (prev.text.trim() !== '' && Number.isFinite(n) && Math.round(n * prev.unit.ms) === value) return prev;
      return seedState(value);
    });
  }, [value]);

  // Exit edit mode on pointerdown outside the group — but never when the
  // pointer is inside the portaled Combobox panel (its picks must land first).
  useEffect(() => {
    if (!onDone) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (groupRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-combobox-panel]')) return;
      onDone();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
  }, [onDone]);

  const onText = (raw: string) => {
    setSt((prev) => ({ ...prev, text: raw }));
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && n >= 0) {
      onChange(Math.min(Math.round(n * st.unit.ms), Number.MAX_SAFE_INTEGER));
    }
  };

  // Unit switch = new typing factor only: the number clears (no conversion —
  // input and display are separate concerns; the chip does the pretty format).
  const pick = (u: DurationUnit) => setSt({ unit: u, text: '' });

  const unitOptions = UNITS.map((u) => ({
    value: u.id,
    label: u.id === 'ms' ? t('duration.ms') : u.id === 's' ? t('duration.s') : u.id === 'min' ? t('duration.min') : t('duration.h'),
  }));

  return (
    <span className="input-group" ref={groupRef} title={title}>
      <input
        type="text"
        inputMode="decimal"
        className="input"
        aria-label={ariaLabel}
        value={st.text}
        autoFocus={autoFocus}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') onDone?.();
        }}
        onChange={(e) => onText(e.target.value)}
        placeholder="0"
        style={{
          width: 72,
          padding: '6px 4px',
          fontSize: 13,
          textAlign: 'center',
          border: 'none',
          background: 'transparent',
        }}
      />
      <Combobox
        value={st.unit.id}
        onChange={(v) => pick(UNITS.find((u) => u.id === v) ?? UNITS[UNITS.length - 1])}
        options={unitOptions}
        panelMinWidth={110}
        style={{
          width: 88,
          padding: '6px 8px',
          fontSize: 12,
          border: 'none',
          background: 'transparent',
          borderRadius: 0,
          borderLeft: '1px solid var(--input-border)',
        }}
      />
    </span>
  );
};
