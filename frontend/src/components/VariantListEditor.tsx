import React from 'react';
import { Plus, X } from 'lucide-react';
import { Combobox, type ComboboxOption } from './Combobox';
import { effortOptionList } from '../lib/effort';
import { useI18n } from '../i18n/I18nContext';

/** One `#<effort>` routing alias: a fixed variant id plus its thinking level. */
export type VariantRow = { id: string; effort: string };

export type VariantListEditorProps = {
  value: VariantRow[];
  /** Receives the whole new array; the caller owns persistence. */
  onChange: (next: VariantRow[]) => void;
  /** Label for the trailing "add" button (i18n, supplied by the caller's namespace). */
  addLabel: string;
  /** Tooltip / aria-label for a row's remove button (i18n). */
  removeLabel: string;
  /**
   * Per-row effort dropdown options. Defaults to the shared ladder with the
   * "unset" sentinel (lib/effort); pass a bare ladder list when the wire form
   * must not be able to emit "no effort".
   */
  options?: ComboboxOption[];
  /** Effort dropdown width in px; the id input takes the remaining space. */
  effortWidth?: number;
};

/**
 * Thinking-variant list editor: one row per variant, each row an id input +
 * an effort dropdown + a remove button, plus a trailing add button.
 *
 * Every control in a row carries the shared `.input` height so the strip reads
 * as one control group — the remove button is a full-height icon button
 * (`.variant-remove`), NOT a stub sized to its glyph, which is what made the
 * row look unbalanced before this component existed.
 */
export const VariantListEditor: React.FC<VariantListEditorProps> = ({
  value,
  onChange,
  addLabel,
  removeLabel,
  options,
  effortWidth = 130,
}) => {
  const { t } = useI18n();
  const effortOptions = options ?? effortOptionList(t);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.map((v, i) => (
        <div key={i} className="variant-row">
          <input
            className="input"
            style={{ fontSize: 11.5, flex: 1, minWidth: 0, fontFamily: "'JetBrains Mono', monospace" }}
            placeholder="variant-id"
            value={v.id}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, id: e.target.value } : x)))}
          />
          <Combobox
            style={{ fontSize: 11.5, width: effortWidth, flexShrink: 0, cursor: 'pointer' }}
            value={v.effort}
            onChange={(effort) => onChange(value.map((x, j) => (j === i ? { ...x, effort } : x)))}
            options={effortOptions}
          />
          <button
            type="button"
            className="btn variant-remove"
            title={removeLabel}
            aria-label={removeLabel}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...value, { id: '', effort: '' }])}>
        <Plus size={12} />
        <span>{addLabel}</span>
      </button>
    </div>
  );
};
