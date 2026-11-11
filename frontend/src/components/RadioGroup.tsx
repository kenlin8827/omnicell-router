import React, { useId } from 'react';

export interface RadioGroupOption {
  value: string;
  label: React.ReactNode;
  /** Secondary line under the label (e.g. "initialized on first use"). */
  description?: React.ReactNode;
  disabled?: boolean;
}

/**
 * Themed single-select radio group. Native inputs keep the semantics and keyboard model; the
 * label is the card, so selection is visible through the theme tokens instead of the platform's
 * default radio chrome. Horizontal groups wrap; vertical groups stack.
 */
export const RadioGroup: React.FC<{
  value: string;
  onChange: (value: string) => void;
  options: RadioGroupOption[];
  /** Accessible name for the group; pair it with the visible field label. */
  ariaLabel?: string;
  orientation?: 'horizontal' | 'vertical';
  /** Override the generated radio name (only needed when composing outside this component). */
  name?: string;
}> = ({ value, onChange, options, ariaLabel, orientation = 'horizontal', name }) => {
  const generated = useId();
  const groupName = name ?? `radio-${generated}`;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`radio-group radio-group--${orientation}`}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className="radio-option"
            data-checked={checked}
            data-disabled={option.disabled ? 'true' : undefined}
          >
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={checked}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="radio-option-text">
              <span className="radio-option-label">{option.label}</span>
              {option.description ? (
                <span className="radio-option-description">{option.description}</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
};
