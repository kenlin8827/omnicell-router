import React from 'react';
import { ArrowUpRight, CloudDownload, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * One-line "a newer release exists" strip between the header and the page
 * canvas. Display-only: the gateway owns the async GitHub check and the link
 * opens the release page. Dismissal is the parent's policy (Layout remembers
 * the dismissed version in localStorage), so a newer release asks again.
 */
export const UpdateBanner: React.FC<{
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  onDismiss: () => void;
}> = ({ currentVersion, latestVersion, releaseUrl, onDismiss }) => {
  const { t } = useI18n();
  return (
    <div className="update-banner" role="status">
      <CloudDownload size={15} />
      <span className="update-banner-text">
        {t('update.banner', { version: latestVersion, current: currentVersion })}
      </span>
      <a className="update-banner-link" href={releaseUrl} target="_blank" rel="noreferrer">
        {t('update.openRelease')}<ArrowUpRight size={13} />
      </a>
      <button type="button" className="update-banner-dismiss" onClick={onDismiss}
        title={t('update.dismiss')} aria-label={t('update.dismiss')}>
        <X size={14} />
      </button>
    </div>
  );
};
