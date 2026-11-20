import React from 'react';
import { Globe } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * Micro-badge toggling between the machine-translated text (`MT`) and the source (`ORIG`).
 */
export const TranslationBadge: React.FC<{
  showingTranslation: boolean;
  onToggle: (e: React.MouseEvent<HTMLButtonElement>) => void;
}> = ({ showingTranslation, onToggle }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="badge"
      onClick={onToggle}
      title={showingTranslation ? t('harness.showOriginal') : t('harness.translated')}
      aria-pressed={showingTranslation}
      style={{
        flex: '0 0 auto',
        fontSize: 'var(--text-2xs)',
        padding: '0 5px',
        letterSpacing: 'var(--tracking-normal)',
        lineHeight: 'var(--leading-15)',
        cursor: 'pointer',
        border: '1px solid var(--divider)',
        background: 'transparent',
        color: showingTranslation ? 'var(--text-dim)' : 'var(--accent-emerald)',
      }}
    >
      {showingTranslation ? t('harness.mtBadge') : t('harness.origBadge')}
    </button>
  );
};

/**
 * Compact icon button triggering on-demand translation for a single description.
 */
export const TranslateButton: React.FC<{
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  size?: number;
  compact?: boolean;
}> = ({ onClick, size = 12, compact = false }) => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={onClick}
      title={t('harness.translate')}
      aria-label={t('harness.translate')}
      style={{
        flex: '0 0 auto',
        ...(compact ? { height: 22, padding: '0 6px' } : {}),
      }}
    >
      <Globe size={size} aria-hidden />
    </button>
  );
};
