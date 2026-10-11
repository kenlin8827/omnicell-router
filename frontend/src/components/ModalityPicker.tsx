import React from 'react';
import { ModalityChips } from './Chip';

export type ModalityPickerProps = {
  input: string[];
  output: string[];
  /** Single callback carrying both directions so callers cannot half-apply an update. */
  onChange: (next: { input: string[]; output: string[] }) => void;
  /** Column sub-labels (i18n strings from the caller's own namespace). */
  inputLabel: string;
  outputLabel: string;
};

/**
 * Input/output modality picker: two labelled columns of `ModalityChips`.
 * Shared by the model editor (ModelEditDialog) and the OCR source editor
 * (CatalogSourcesPage) so both expose the same vocabulary in the same shape —
 * they previously carried separate copies of the same native-checkbox row.
 */
export const ModalityPicker: React.FC<ModalityPickerProps> = ({ input, output, onChange, inputLabel, outputLabel }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
    {(['input', 'output'] as const).map((dir) => (
      <div key={dir}>
        <div className="field-sub-label">{dir === 'input' ? inputLabel : outputLabel}</div>
        <ModalityChips
          value={dir === 'input' ? input : output}
          onChange={(next) => onChange(dir === 'input' ? { input: next, output } : { input, output: next })}
        />
      </div>
    ))}
  </div>
);