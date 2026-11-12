import React from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

export type SearchInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  style?: React.CSSProperties;
};

/**
 * Clearable search field — the app-wide search box. Left search icon and a
 * clear (×) button that appears as soon as the field holds text; clicking it
 * empties the field and returns focus to the input. Consumers own the query
 * state; `onChange` fires for both typing and clearing.
 */
export const SearchInput: React.FC<SearchInputProps> = ({ value, onChange, placeholder, style }) => {
  const { t } = useI18n();
  const ref = React.useRef<HTMLInputElement>(null);
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 200, ...style }}>
      <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)', pointerEvents: 'none' }} />
      <input
        ref={ref}
        className="input"
        style={{ fontSize: 'var(--text-sm)', paddingLeft: 30, paddingRight: value ? 26 : 10, width: '100%' }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          title={t('common.clear')}
          onClick={() => { onChange(''); ref.current?.focus(); }}
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: '50%',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-dim)',
            cursor: 'pointer',
            padding: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-main)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};
