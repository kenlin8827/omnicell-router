import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from './Dialog';
import { Chip } from './Chip';
import { useI18n } from '../i18n/I18nContext';

/**
 * Editable list of glob patterns (one input per row) — used by the model-side
 * proxy include/exclude rules on the Proxy Patterns page. The Proxy Access
 * page's bypass list has its own richer row editor (per-row "via outbound
 * proxy" checkbox).
 *
 * `suggestions` are one-click patterns the caller derived from live state
 * (e.g. `<provider>/*` for every connected provider). They are shortcuts for
 * the SAME free-text list — nothing is preselected or seeded. They live behind
 * a button that opens a multi-select dialog: picking only APPENDS rows, so an
 * apply can never rewrite what the operator already typed.
 */
export const PatternListEditor: React.FC<{
  label: string;
  placeholder: string;
  addLabel: string;
  patterns: string[];
  onChange: (patterns: string[]) => void;
  suggestions?: string[];
}> = ({ label, placeholder, addLabel, patterns, onChange, suggestions }) => {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const openPicker = () => {
    setPicked([]);
    setPickerOpen(true);
  };

  const quickAdds = suggestions ?? [];

  const applyPicked = () => {
    onChange([...patterns, ...picked.filter(p => !patterns.includes(p))]);
    setPickerOpen(false);
  };

  return (
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
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn btn-sm"
            style={{ gap: '6px' }}
            onClick={() => onChange([...patterns, ''])}
          >
            <Plus size={14} />
            <span>{addLabel}</span>
          </button>
          {quickAdds.length > 0 && (
            <button className="btn btn-sm" onClick={openPicker}>
              {t('proxyPatterns.quickAdd')}
            </button>
          )}
        </div>
      </div>
      {pickerOpen && (
        <Dialog
          title={t('proxyPatterns.quickAdd')}
          subtitle={t('proxyPatterns.quickAddHint')}
          onClose={() => setPickerOpen(false)}
          closeLabel={t('common.close')}
          width={560}
          footerRight={
            <>
              <button className="btn btn-sm" onClick={() => setPickerOpen(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary btn-sm" disabled={picked.length === 0} onClick={applyPicked}>
                {t('proxyPatterns.quickAddApply', { n: picked.length })}
              </button>
            </>
          }
        >
          <div className="chip-row">
            {quickAdds.map(s => (
              <Chip
                key={s}
                label={s}
                pressed={picked.includes(s)}
                onToggle={() => setPicked(prev => (prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]))}
              />
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
};
