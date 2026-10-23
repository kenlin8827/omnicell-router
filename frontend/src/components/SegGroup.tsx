import React from 'react';

/**
 * Joined segmented switch (single-select): one bordered container, shared
 * dividers. Used for view-mode switches and short mutually exclusive filters.
 * `aria-pressed` per button keeps the group keyboard-reachable; labels are
 * always caller-supplied i18n strings.
 */
export const SegGroup: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; title?: string }[];
}> = ({ value, onChange, options }) => (
  <div
    role="group"
    style={{
      display: 'inline-flex',
      border: '1px solid var(--divider)',
      borderRadius: '8px',
      overflow: 'hidden',
      background: 'var(--btn-bg)',
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
            padding: '5px 12px',
            fontSize: '12px',
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
