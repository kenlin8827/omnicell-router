import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

/**
 * Editable list of glob patterns (one input per row) — used by the outbound
 * proxy include/exclude rules. The Proxy Access page's bypass list has its own
 * richer row editor (per-row "via outbound proxy" checkbox).
 */
export const PatternListEditor: React.FC<{
  label: string;
  placeholder: string;
  addLabel: string;
  patterns: string[];
  onChange: (patterns: string[]) => void;
}> = ({ label, placeholder, addLabel, patterns, onChange }) => (
  <div>
    <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: '4px', display: 'block' }}>{label}</label>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {patterns.map((p, idx) => (
        <div key={idx} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder={placeholder}
            value={p || ''}
            onChange={e => {
              const next = [...patterns];
              next[idx] = e.target.value;
              onChange(next);
            }}
            className="input"
          />
          <button
            className="btn btn-danger btn-sm"
            style={{ padding: '4px 8px' }}
            onClick={() => onChange(patterns.filter((_, i) => i !== idx))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        className="btn btn-sm"
        style={{ alignSelf: 'flex-start', gap: '6px' }}
        onClick={() => onChange([...patterns, ''])}
      >
        <Plus size={14} />
        <span>{addLabel}</span>
      </button>
    </div>
  </div>
);